// 基于WebUSB的STLINK连接与烧录实现
// 参考: https://github.com/devanlai/webstlink

const STLINK_USB_VID = 0x0483; // STMicroelectronics
const STLINK_USB_PID_LIST = [0x3748, 0x374b, 0x374a, 0x3752]; // ST-LINK/V2, V2-1, V3等

// STLINK命令常量
const STLINK_GET_VERSION = 0xf1;
const STLINK_DEBUG_COMMAND = 0xf2;
const STLINK_DEBUG_ENTER = 0x20;
const STLINK_DEBUG_ENTER_SWD = 0xa3;
const STLINK_DEBUG_WRITE_MEM_32BIT = 0x0d;
const STLINK_DEBUG_ERASE_FLASH = 0x43;
const STLINK_DEBUG_RUNCORE = 0x21;
const STLINK_DEBUG_RESETSYS = 0x22;
const STLINK_DEBUG_FORCEDEBUG = 0xa4;
const STLINK_DEBUG_APIV2_SWD_SET_FREQ = 0x43;
const STLINK_DEBUG_READCOREID = 0x33;
const STLINK_DEBUG_HALTCODE = 0x00;
const STLINK_DEBUG_HALT = 0x02;

function padCmd(cmd, len = 16) {
  if (cmd.length >= len) return new Uint8Array(cmd);
  const arr = new Uint8Array(len);
  arr.set(cmd);
  return arr;
}

export default class STLink {
  constructor() {
    this.device = null;
    this.interfaceNumber = null;
    this.endpointIn = null;
    this.endpointOut = null;
  }

  // 选择并连接STLINK设备
  async connect() {
    const filters = STLINK_USB_PID_LIST.map((pid) => ({
      vendorId: STLINK_USB_VID,
      productId: pid,
    }));
    this.device = await navigator.usb.requestDevice({ filters });
    await this.device.open();
    if (this.device.configuration === null) {
      await this.device.selectConfiguration(1);
    }
    // 查找type为bulk的接口和端点
    const iface = this.device.configuration.interfaces.find((i) =>
      i.alternate.endpoints.some(
        (e) => e.direction === "out" && e.type === "bulk"
      )
    );
    if (!iface) throw new Error("未找到STLINK接口");
    this.interfaceNumber = iface.interfaceNumber;
    await this.device.claimInterface(this.interfaceNumber);
    const epIn = iface.alternate.endpoints.find(
      (e) => e.direction === "in" && e.type === "bulk"
    );
    const epOut = iface.alternate.endpoints.find(
      (e) => e.direction === "out" && e.type === "bulk"
    );
    if (!epIn || !epOut) throw new Error("未找到STLINK端点");
    this.endpointIn = epIn.endpointNumber;
    this.endpointOut = epOut.endpointNumber;
    // 调试日志
    console.log(
      "STLINK接口:",
      this.interfaceNumber,
      "IN端点:",
      this.endpointIn,
      "OUT端点:",
      this.endpointOut
    );
    return this.device;
  }

  async disconnect() {
    if (this.device) {
      try {
        await this.device.releaseInterface(this.interfaceNumber);
        await this.device.close();
      } catch (e) {}
      this.device = null;
      this.interfaceNumber = null;
      this.endpointIn = null;
      this.endpointOut = null;
    }
  }

  async send(data) {
    if (!this.device) throw new Error("设备未连接");
    // 补齐16字节
    return await this.device.transferOut(this.endpointOut, padCmd(data));
  }

  async receive(length = 16) {
    if (!this.device) throw new Error("设备未连接");
    const result = await this.device.transferIn(this.endpointIn, length);
    return new Uint8Array(result.data.buffer);
  }

  // 获取STLINK版本，确认设备可用
  async getVersion() {
    await this.send([STLINK_GET_VERSION]);
    const resp = await this.receive();
    // 可解析resp内容
    return resp;
  }

  // 进入SWD模式
  async enterSWD() {
    await this.send([
      STLINK_DEBUG_COMMAND,
      STLINK_DEBUG_ENTER,
      STLINK_DEBUG_ENTER_SWD,
    ]);
    await new Promise((r) => setTimeout(r, 20));
  }

  // 设置SWD频率（可选，部分设备支持）
  async setSWDFreq(freq = 1800000) {
    // 0xF2 0x43 + 4字节频率（小端）
    const freqBytes = [
      freq & 0xff,
      (freq >> 8) & 0xff,
      (freq >> 16) & 0xff,
      (freq >> 24) & 0xff,
    ];
    await this.send([
      STLINK_DEBUG_COMMAND,
      STLINK_DEBUG_APIV2_SWD_SET_FREQ,
      ...freqBytes,
    ]);
    await new Promise((r) => setTimeout(r, 10));
  }

  // halt core
  async halt() {
    await this.send([STLINK_DEBUG_COMMAND, STLINK_DEBUG_HALT]);
    await new Promise((r) => setTimeout(r, 10));
  }

  // 擦除Flash（全擦除）
  async eraseFlash() {
    await this.send([
      STLINK_DEBUG_COMMAND,
      STLINK_DEBUG_ERASE_FLASH,
      0xff,
      0xff,
      0xff,
      0xff,
    ]);
    await new Promise((r) => setTimeout(r, 1000));
  }

  // 写入一段数据到指定地址（32位对齐，分包最大128字节，命令和数据都16字节补齐）
  async writeMemory(address, data) {
    if (data.length % 4 !== 0) {
      const padded = new Uint8Array(Math.ceil(data.length / 4) * 4);
      padded.set(data);
      data = padded;
    }
    const len = data.length;
    const addrBytes = [
      address & 0xff,
      (address >> 8) & 0xff,
      (address >> 16) & 0xff,
      (address >> 24) & 0xff,
    ];
    const lenBytes = [
      len & 0xff,
      (len >> 8) & 0xff,
      (len >> 16) & 0xff,
      (len >> 24) & 0xff,
    ];
    // 分包写入，每次最大128字节
    for (let offset = 0; offset < len; offset += 128) {
      const chunk = data.slice(offset, offset + 128);
      const chunkLen = chunk.length;
      const chunkAddr = address + offset;
      const chunkAddrBytes = [
        chunkAddr & 0xff,
        (chunkAddr >> 8) & 0xff,
        (chunkAddr >> 16) & 0xff,
        (chunkAddr >> 24) & 0xff,
      ];
      const chunkLenBytes = [
        chunkLen & 0xff,
        (chunkLen >> 8) & 0xff,
        (chunkLen >> 16) & 0xff,
        (chunkLen >> 24) & 0xff,
      ];
      // 发送写入命令头（16字节）
      await this.send([
        STLINK_DEBUG_COMMAND,
        STLINK_DEBUG_WRITE_MEM_32BIT,
        ...chunkAddrBytes,
        ...chunkLenBytes,
      ]);
      // 分包发送数据，每包16字节
      for (let i = 0; i < chunkLen; i += 16) {
        const dataPacket = Array.from(chunk.slice(i, i + 16));
        await this.send(dataPacket);
      }
      await new Promise((r) => setTimeout(r, 2));
    }
  }

  // 复位MCU
  async reset() {
    await this.send([STLINK_DEBUG_COMMAND, STLINK_DEBUG_RESETSYS]);
    await new Promise((r) => setTimeout(r, 20));
  }

  // force debug
  async forceDebug() {
    await this.send([STLINK_DEBUG_COMMAND, STLINK_DEBUG_FORCEDEBUG]);
    await new Promise((r) => setTimeout(r, 10));
  }

  // 下载二进制数据到目标单片机
  async downloadBin(
    arrayBuffer,
    baseAddress = 0x08000000,
    progressCallback = null,
    swdFreq = 1800000
  ) {
    try {
      // 1. 获取版本，确认设备可用
      await this.getVersion();
      // 2. 进入SWD
      await this.enterSWD();
      // 3. force debug
      await this.forceDebug();
      // 3.5 设置SWD频率
      await this.setSWDFreq(swdFreq);
      // 4. halt core
      await this.halt();
      // 5. 擦除
      await this.eraseFlash();
      await new Promise((r) => setTimeout(r, 500)); // 擦除后延时更长
      // 6. 分块写入
      const data = new Uint8Array(arrayBuffer);
      const totalSize = data.length;
      const chunkSize = 256;
      let bytesWritten = 0;
      for (let offset = 0; offset < totalSize; offset += chunkSize) {
        const chunk = data.slice(offset, offset + chunkSize);
        await this.writeMemory(baseAddress + offset, chunk);
        await new Promise((r) => setTimeout(r, 10)); // 每块写入后延时
        bytesWritten += chunk.length;
        if (progressCallback) progressCallback(bytesWritten, totalSize);
      }
      // 7. 复位
      await this.reset();
    } catch (e) {
      // 增加详细错误日志
      console.error("STLINK烧录异常:", e);
      throw e;
    }
  }
}
