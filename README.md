# stm32.download

一个基于 web api 的 stm32 固件烧录工具，支持 `uart`、`usb`、`st-link` 三种模式

- 环境要求：`Chrome`、`Microsoft Edge`、`Arc` 等基于 Chromium 的浏览器
- 访问地址：[https://stm32.download](https://stm32.download)

## 使用方法

- UART 模式

  - 确保 USB 转串口芯片的驱动已安装（CH340、CP2102、FT232 等）
  - 配置目标板进入 ISP 模式（BOOT0=1）
  - 使用 USB 转串口线将目标板（PA9、PA10）连接到电脑

- USB-DFU 模式

  - 使用 `Zadig` 安装目标板的 USB 驱动
  - 配置目标板进入 ISP 模式（BOOT0=1）
  - 使用 USB 线将目标板的原生 USB（PA11、PA12）接口连接到电脑

- ST-Link 模式

  - 确保 ST-Link 的驱动已安装
  - 使用 ST-Link 将连接到目标板 SWD 接口（PA13、PA14）
  - 使用 USB 线将 ST-Link 连接到电脑

- DAP-Link 模式

  - 确保 DAP-Link 的驱动已安装
  - 使用 DAP-Link 将连接到目标板 SWD 接口（PA13、PA14）
  - 使用 USB 线将 DAP-Link 连接到电脑
