// lib/device-battery.ts
//
// 读取真实设备电池状态（Battery Status API）。
//
// 注意：这是浏览器的实验性 / 已废弃 API，目前只有 Chrome、Edge 桌面版和
// Android 系统内浏览器支持；Safari、Firefox、iOS 全系（包括 iOS 上的 Chrome，
// 因为底层内核仍是 WebKit）都不支持，并且要求页面运行在 HTTPS（或 localhost）
// 环境下。不支持时必须如实返回 supported:false，调用方不能假装拿到了数据。

export type DeviceBatteryStatus = {
    supported: boolean;
    level: number | null;      // 0-100 的整数百分比，不支持时为 null
    charging: boolean | null;  // 是否正在充电，不支持时为 null
};

interface BatteryManagerLike {
    charging: boolean;
    level: number; // 0-1
}

interface NavigatorWithBattery extends Navigator {
    getBattery?: () => Promise<BatteryManagerLike>;
}

/**
 * 读取当前设备的真实电池电量。
 * 只能在浏览器主线程调用；服务端环境或不支持的浏览器会返回 supported:false。
 */
export async function readDeviceBatteryStatus(): Promise<DeviceBatteryStatus> {
    if (typeof navigator === "undefined") {
        return { supported: false, level: null, charging: null };
    }

    const nav = navigator as NavigatorWithBattery;
    if (typeof nav.getBattery !== "function") {
        return { supported: false, level: null, charging: null };
    }

    try {
        const battery = await nav.getBattery();
        return {
            supported: true,
            level: Math.max(0, Math.min(100, Math.round(battery.level * 100))),
            charging: battery.charging,
        };
    } catch {
        return { supported: false, level: null, charging: null };
    }
}

/** 把电池状态格式化成给模型看的一段中文文本（作为工具执行结果返回）。 */
export function formatDeviceBatteryStatusForTool(status: DeviceBatteryStatus): string {
    if (!status.supported || status.level === null) {
        return "当前设备不支持读取真实电量（该浏览器/系统未提供电量信息接口），不要在对话里编造具体电量数字，可以换个方式回应或不提这件事。";
    }
    const chargingText = status.charging ? "正在充电" : "未充电";
    return `设备当前真实电量：${status.level}%，${chargingText}。`;
}
