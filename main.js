import UARTISP, { hexToBin } from "./uart_isp.js";
import WebStlink from "./webstlink/src/webstlink.js";
import { Logger } from "./webstlink/src/lib/package.js";

// // Web Serial API 支持性检查
// if (!("serial" in navigator)) {
//   alert(
//     "暂不支持当前浏览器，请使用 Chrome、Microsoft Edge、Arc 等基于 Chromium 的浏览器。"
//   );
//   throw new Error("Web Serial API not supported");
// }

let port = null;
let uartisp = null;
let firmwareBuffer = null;
let firmwareBaseAddr = 0x08000000;
let firmwareSize = 0;
let isConnected = false;
let isBurning = false;
let isCancelRequested = false;
let burnStartTime = 0;
let lastWritten = 0;
let lastTime = 0;

const logEl = document.getElementById("log");
const btnSerial = document.getElementById("btn-serial");
const btnBurn = document.getElementById("btn-burn");
const firmwareInput = document.getElementById("firmware");
const fileInfo = document.getElementById("file-info");
const eta = document.getElementById("eta");
const etaText = document.getElementById("eta-text");
const baudrateSelect = document.getElementById("baudrate");
const progressBarContainer = document.getElementById("progress-bar-container");

// 模式切换显示不同选项
const modeRadios = document.querySelectorAll('input[name="mode"]');
const baudrateContainer = document.getElementById("baudrate-container");
const stlinkrateContainer = document.getElementById("stlinkrate-container");

function log(msg) {
  logEl.textContent += `[${new Date().toLocaleTimeString()}] ${msg}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}
function setProgress(percent) {
  document.getElementById("progress-inner").style.width = percent + "%";
}
function resetProgress() {
  setProgress(0);
}

function setSerialBtnState(connected) {
  if (connected) {
    btnSerial.textContent = "⛓️‍💥断开";
    btnSerial.classList.remove("bg-blue-600");
    btnSerial.classList.add("bg-red-600");
    btnBurn.disabled = false;
  } else {
    btnSerial.textContent = "🔗连接";
    btnSerial.classList.remove("bg-red-600");
    btnSerial.classList.add("bg-blue-600");
    btnBurn.disabled = true;
  }
}

function updateBurnBtnState() {
  btnBurn.disabled = !firmwareBuffer;
  if (btnBurn.disabled) {
    btnBurn.classList.add("bg-blue-300", "cursor-not-allowed");
    btnBurn.classList.remove("bg-blue-600");
  } else {
    btnBurn.classList.remove("bg-blue-300", "cursor-not-allowed");
    btnBurn.classList.add("bg-blue-600");
  }
}

firmwareInput.onchange = async (e) => {
  resetProgress();
  const file = e.target.files[0];
  if (!file) {
    firmwareBuffer = null;
    fileInfo.textContent = "";
    updateBurnBtnState();
    return;
  }
  // 显示文件名和大小
  const sizeStr =
    file.size > 1024 * 1024
      ? (file.size / 1024 / 1024).toFixed(2) + " MB"
      : (file.size / 1024).toFixed(2) + " KB";
  fileInfo.textContent = `${file.name} (${sizeStr})`;
  const ext = file.name.split(".").pop().toLowerCase();
  try {
    if (ext === "hex") {
      const url = URL.createObjectURL(file);
      const { arrayBuffer, baseAddr, size } = await hexToBin(url);
      firmwareBuffer = arrayBuffer;
      firmwareBaseAddr = baseAddr;
      firmwareSize = size;
      log(
        `HEX文件已加载，基地址: 0x${baseAddr
          .toString(16)
          .toUpperCase()}，大小: ${size} 字节`
      );
    } else if (ext === "bin") {
      firmwareBuffer = await file.arrayBuffer();
      firmwareBaseAddr = 0x08000000;
      firmwareSize = firmwareBuffer.byteLength;
      log(`BIN文件已加载，大小: ${firmwareSize} 字节，基地址: 0x08000000`);
    } else {
      log("不支持的文件类型");
      firmwareBuffer = null;
    }
  } catch (e) {
    log("固件文件加载失败: " + e.message);
    firmwareBuffer = null;
  }
  updateBurnBtnState();
};

// 初始禁用烧录按钮
btnBurn.disabled = true;
btnBurn.classList.add("bg-blue-300", "cursor-not-allowed");
btnBurn.classList.remove("bg-blue-600");

btnBurn.onclick = async () => {
  const icon = document.getElementById("btn-burn-icon");
  const mode = document.querySelector('input[name="mode"]:checked').value;
  console.log("当前模式:", mode);
  if (isBurning) {
    if (!confirm("是否真的要终止下载？")) return;
    isCancelRequested = true;
    log("⏹️ 用户请求取消下载...");
    setProgress(0);
    return;
  }
  if (!firmwareBuffer) return;
  // 新增：根据模式分支
  if (mode === "STLINK") {
    try {
      log("🔌 正在连接STLINK设备...");
      // 选择 STLINK 设备，带过滤器
      const device = await navigator.usb.requestDevice({
        filters:
          Logger && Logger.usb && Logger.usb.filters
            ? Logger.usb.filters
            : [
                { vendorId: 0x0483 }, // STMicroelectronics
              ],
      });
      // 创建 logger 用于进度条
      class UIProgressLogger extends Logger {
        bargraph_start(msg, { value_min = 0, value_max = 100 } = {}) {
          super.bargraph_start(msg, { value_min, value_max });
          this._isWrite = msg === "Writing FLASH";
          if (this._isWrite && firmwareBuffer) {
            progressBarContainer.style.display = "block";
            document.getElementById("progress-inner").style.width = "0%";
          }
        }
        bargraph_update({ value = 0 } = {}) {
          super.bargraph_update({ value });
          if (this._isWrite && firmwareBuffer) {
            const percent = Math.floor(
              ((value - firmwareBaseAddr) / firmwareSize) * 100
            );
            setProgress(percent);
          }
        }
        bargraph_done() {
          super.bargraph_done();
          if (this._isWrite && firmwareBuffer) {
            setProgress(100);
          }
        }
      }
      const logger = new UIProgressLogger(1, null);
      const stlink = new WebStlink(logger);
      await stlink.attach(device);
      await stlink.detect_cpu([], pick_sram_variant);
      log("✅ STLINK已连接: " + device.productName);
      log("📝 开始通过STLINK写入固件...");
      setProgress(0);
      const stlinkrate =
        parseInt(document.getElementById("stlinkrate").value, 10) || 1800000;
      // WebStlink.flash(addr, data) 支持 Uint8Array
      await stlink.flash(firmwareBaseAddr, new Uint8Array(firmwareBuffer));
      setProgress(100);
      log("🎉 STLINK固件烧录完成！");
      await stlink.detach();
      log("⛓️‍💥 STLINK已断开");
    } catch (e) {
      log("❌ STLINK烧录失败: " + (e && e.message ? e.message : e));
    }
    isBurning = false;
    isCancelRequested = false;
    etaText.textContent = "";
    if (eta) eta.style.visibility = "hidden";
    baudrateSelect.disabled = false;
    baudrateSelect.classList.remove("opacity-50", "cursor-not-allowed");
    firmwareInput.disabled = false;
    document
      .getElementById("custom-file-btn")
      .classList.remove("opacity-50", "cursor-not-allowed");
    progressBarContainer.style.display = "none";
    updateBurnBtnState();
    return;
  }
  if (mode === "UART") {
    try {
      console.log("即将调用navigator.serial.requestPort");
      if (navigator.serial && navigator.serial.requestPort) {
        port = await navigator.serial.requestPort();
        log("✅ 串口已选择");
        // 这里可以继续你的串口通信逻辑...
      } else {
        log("❌ 当前浏览器不支持Web Serial API");
      }
    } catch (e) {
      console.error("UART分支异常:", e);
      log("❌ 串口连接失败: " + e.message);
    }
    return;
  }
  isBurning = true;
  isCancelRequested = false;
  burnStartTime = 0;
  lastWritten = 0;
  lastTime = 0;
  etaText.textContent = "";
  if (eta) eta.style.visibility = "hidden";
  baudrateSelect.disabled = true;
  baudrateSelect.classList.add("opacity-50", "cursor-not-allowed");
  firmwareInput.disabled = true;
  document
    .getElementById("custom-file-btn")
    .classList.add("opacity-50", "cursor-not-allowed");
  try {
    btnBurn.classList.remove(
      "bg-blue-600",
      "hover:bg-blue-700",
      "active:bg-blue-800"
    );
    btnBurn.classList.add("bg-red-600");
    document.getElementById("btn-burn-text").textContent = "终止";
    if (icon) {
      icon.className = "fa-solid fa-stop mr-1";
    }
    btnBurn.disabled = false;
    port = await navigator.serial.requestPort();
    // 选择串口后显示进度条
    progressBarContainer.style.display = "block";
    const baudrate = parseInt(document.getElementById("baudrate").value);
    await port.open({ baudRate: baudrate });
    uartisp = new UARTISP();
    await uartisp.open(port);
    log(`🔗 串口已连接，波特率: ${baudrate}`);
    setProgress(0);
    log("🤝 开始握手...");
    if (isCancelRequested) throw new Error("已取消");
    await uartisp.handshake();
    if (isCancelRequested) throw new Error("已取消");
    log("🤝 握手成功，获取芯片ID...");
    const id = await uartisp.getChipId(10);
    if (isCancelRequested) throw new Error("已取消");
    log(
      "🆔 芯片ID: " +
        Array.from(id)
          .map((b) => b.toString(16).padStart(2, "0"))
          .join(" ")
    );
    log("🧹 擦除Flash...");
    await uartisp.eraseAll();
    if (isCancelRequested) throw new Error("已取消");
    log("📝 Flash已擦除，开始写入固件...");
    if (eta) eta.style.visibility = "visible";
    burnStartTime = Date.now();
    lastWritten = 0;
    lastTime = burnStartTime;
    await uartisp.downloadBin(
      firmwareBuffer,
      firmwareBaseAddr,
      (written, total) => {
        setProgress(Math.floor((written / total) * 100));
        if (isCancelRequested) throw new Error("已取消");
        const now = Date.now();
        if (written > 0 && now - lastTime > 500) {
          const elapsed = (now - burnStartTime) / 1000;
          const speed = written / elapsed;
          const remain = total - written;
          const etaSec = speed > 0 ? Math.round(remain / speed) : 0;
          const mm = String(Math.floor(etaSec / 60)).padStart(2, "0");
          const ss = String(etaSec % 60).padStart(2, "0");
          etaText.textContent = `${mm}:${ss}`;
          lastTime = now;
        }
      }
    );
    setProgress(100);
    etaText.textContent = "00:00";
    log("🎉 固件烧录完成！");
    await uartisp.close();
    await port.close();
    log("⛓️‍💥 串口已断开");
    uartisp = null;
    port = null;
    btnBurn.classList.remove("bg-red-600");
    btnBurn.classList.add(
      "bg-blue-600",
      "hover:bg-blue-700",
      "active:bg-blue-800"
    );
    document.getElementById("btn-burn-text").textContent = "下载固件";
    if (icon) {
      icon.className = "fa-solid fa-bolt mr-1";
    }
    updateBurnBtnState();
  } catch (e) {
    etaText.textContent = "";
    log("❌ 烧录失败: " + e.message);
    try {
      if (uartisp) await uartisp.close();
      if (port) await port.close();
    } catch {}
    uartisp = null;
    port = null;
    btnBurn.classList.remove("bg-red-600");
    btnBurn.classList.add(
      "bg-blue-600",
      "hover:bg-blue-700",
      "active:bg-blue-800"
    );
    document.getElementById("btn-burn-text").textContent = "下载固件";
    if (icon) {
      icon.className = "fa-solid fa-bolt mr-1";
    }
    updateBurnBtnState();
  }
  isBurning = false;
  isCancelRequested = false;
  etaText.textContent = "";
  if (eta) eta.style.visibility = "hidden";
  baudrateSelect.disabled = false;
  baudrateSelect.classList.remove("opacity-50", "cursor-not-allowed");
  firmwareInput.disabled = false;
  document
    .getElementById("custom-file-btn")
    .classList.remove("opacity-50", "cursor-not-allowed");
  progressBarContainer.style.display = "none";
};

// 保证页面加载时按钮状态正确
updateBurnBtnState();

function updateModeOptions() {
  const mode = document.querySelector('input[name="mode"]:checked').value;
  if (mode === "UART") {
    baudrateContainer.style.display = "";
    stlinkrateContainer.style.display = "none";
  } else if (mode === "USB") {
    baudrateContainer.style.display = "none";
    stlinkrateContainer.style.display = "none";
  } else if (mode === "STLINK") {
    baudrateContainer.style.display = "none";
    stlinkrateContainer.style.display = "";
  }
}
modeRadios.forEach((r) => r.addEventListener("change", updateModeOptions));
// 页面加载时初始化
updateModeOptions();

// MCU选型弹窗逻辑，参考webstlink demo
async function pick_sram_variant(mcu_list) {
  const dialog = document.getElementById("mcuDialog");
  const tbody = dialog.querySelector("tbody");
  // 清空旧内容
  while (tbody.firstChild) tbody.removeChild(tbody.firstChild);
  const columns = [
    ["type", ""],
    ["freq", "MHz"],
    ["flash_size", "KiB"],
    ["sram_size", "KiB"],
    ["eeprom_size", "KiB"],
  ];
  mcu_list.forEach((mcu, idx) => {
    const tr = document.createElement("tr");
    tr.className =
      idx % 2 === 0
        ? "bg-white hover:bg-blue-50 cursor-pointer"
        : "bg-blue-50 hover:bg-blue-100 cursor-pointer";
    for (const [key, suffix] of columns) {
      const td = document.createElement("td");
      td.className = "px-3 py-2 border-b";
      if (key === "type") {
        const label = document.createElement("label");
        label.className = "flex items-center gap-2 select-none";
        const input = document.createElement("input");
        input.type = "radio";
        input.name = "mcuIndex";
        input.value = mcu.type;
        input.required = true;
        input.className = "w-5 h-5 accent-blue-600";
        label.appendChild(input);
        label.appendChild(document.createTextNode(mcu[key] + suffix));
        td.appendChild(label);
      } else {
        td.textContent = mcu[key] + suffix;
      }
      tr.appendChild(td);
    }
    // 点击整行选中radio
    tr.addEventListener("click", (e) => {
      const radio = tr.querySelector('input[type="radio"]');
      if (radio) radio.checked = true;
    });
    tbody.appendChild(tr);
  });
  // 处理提交/取消
  const form = document.getElementById("mcuForm");
  let submitHandler, cancelHandler;
  const submitPromise = new Promise((resolve, reject) => {
    submitHandler = (evt) => {
      evt.preventDefault();
      dialog.removeEventListener("close", cancelHandler);
      const val = form.elements["mcuIndex"]?.value;
      dialog.close();
      resolve(val);
    };
    cancelHandler = () => {
      form.removeEventListener("submit", submitHandler);
      reject();
    };
    form.addEventListener("submit", submitHandler, { once: true });
    dialog.addEventListener("close", cancelHandler, { once: true });
  });
  dialog.showModal();
  try {
    const type = await submitPromise;
    return type;
  } catch {
    return null;
  }
}
