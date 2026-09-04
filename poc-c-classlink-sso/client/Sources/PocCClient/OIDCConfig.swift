import Foundation

struct OIDCConfig: Codable {
    let issuer: URL              // e.g. https://launchpad.classlink.com
    let authEndpoint: URL        // e.g. https://launchpad.classlink.com/oauth2/v2/auth
    let tokenEndpoint: URL       // e.g. https://launchpad.classlink.com/oauth2/v2/token
    let clientId: String
    let redirectURI: String      // e.g. securetestpoc://callback — must match Partner Portal app
    let scopes: [String]         // e.g. ["openid", "profile", "email", "oneroster"]
    let usePKCE: Bool            // PoC will set true; if ClassLink rejects, flip to false
    let callbackURLScheme: String // the scheme portion of redirectURI

    static func load() throws -> OIDCConfig {
        // Look for config.json next to the executable, then in CWD, then ~/.poc-c-config.json.
        let fm = FileManager.default
        let candidates: [URL] = [
            URL(fileURLWithPath: fm.currentDirectoryPath).appendingPathComponent("config.json"),
            fm.homeDirectoryForCurrentUser.appendingPathComponent(".poc-c-config.json")
        ]
        for url in candidates {
            if fm.fileExists(atPath: url.path) {
                let data = try Data(contentsOf: url)
                return try JSONDecoder().decode(OIDCConfig.self, from: data)
            }
        }
        throw NSError(
            domain: "PocC.Config",
            code: 1,
            userInfo: [NSLocalizedDescriptionKey: "config.json not found. See README."]
        )
    }
}
