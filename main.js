import UARTISP, { hexToBin } from "./uart_isp.js";
// import USBDFU from "./usb_dfu.js";
// import STLink from "./stlink.js";

// Web Serial API 支持性检查
if (!("serial" in navigator)) {
  alert(
    "暂不支持当前浏览器，请使用 Chrome、Microsoft Edge、Arc 等基于 Chromium 的浏览器。"
  );
  throw new Error("Web Serial API not supported");
}

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

// 页面初始隐藏烧录按钮和进度条
btnBurn.style.display = "none";
progressBarContainer.style.display = "none";

firmwareInput.onchange = async (e) => {
  resetProgress();
  const file = e.target.files[0];
  if (!file) {
    firmwareBuffer = null;
    fileInfo.textContent = "";
    btnBurn.style.display = "none";
    progressBarContainer.style.display = "none";
    updateBurnBtnState();
    return;
  }
  // 显示文件名和大小
  const sizeStr =
    file.size > 1024 * 1024
      ? (file.size / 1024 / 1024).toFixed(2) + " MB"
      : (file.size / 1024).toFixed(2) + " KB";
  fileInfo.textContent = `${file.name} (${sizeStr})`;
  btnBurn.style.display = "block";
  progressBarContainer.style.display = "none";
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
  if (isBurning) {
    if (!confirm("是否真的要终止下载？")) return;
    isCancelRequested = true;
    log("⏹️ 用户请求取消下载...");
    setProgress(0);
    return;
  }
  if (!firmwareBuffer) return;
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
    const id = await uartisp.getChipId();
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
