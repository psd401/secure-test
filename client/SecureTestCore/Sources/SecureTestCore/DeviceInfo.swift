import Darwin
import Foundation

/// Field report 2026-10-08: `AEAssessmentErrorDomain` code 1 ("Unknown") refused
/// 17 students' secure sessions in 30 days, and the only detail the server kept
/// was the error text — no way to tell which macOS versions or Mac models it
/// hits. These two values ride on `lockdown_failed` so the next query can.
///
/// Neither identifies a student or a device: the model is the hardware family
/// (`Mac15,12`), never a serial number.
public enum DeviceInfo {
    /// "26.4.1" — major.minor.patch, no build number.
    public static var osVersion: String {
        let v = ProcessInfo.processInfo.operatingSystemVersion
        return "\(v.majorVersion).\(v.minorVersion).\(v.patchVersion)"
    }

    /// `hw.model`, e.g. "Mac15,12"; "unknown" if sysctl refuses.
    public static var model: String {
        var size = 0
        guard sysctlbyname("hw.model", nil, &size, nil, 0) == 0, size > 0 else { return "unknown" }
        var buffer = [CChar](repeating: 0, count: size)
        guard sysctlbyname("hw.model", &buffer, &size, nil, 0) == 0 else { return "unknown" }
        return String(cString: buffer)
    }

    /// The detail keys `lockdown_failed` carries beside `reason`.
    public static var lockdownFailureDetail: [String: String] {
        ["os_version": osVersion, "model": model]
    }
}
