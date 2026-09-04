import AuthenticationServices
import AppKit
import Foundation

final class OIDCClient: NSObject, ASWebAuthenticationPresentationContextProviding {
    private let config: OIDCConfig
    private var currentPKCE: PKCE?
    private var refreshToken: String?
    private var session: ASWebAuthenticationSession?

    var onLog: ((String) -> Void)?

    init(config: OIDCConfig) { self.config = config }

    func startAuthFlow() async {
        let pkce = PKCE.generate()
        currentPKCE = pkce

        var components = URLComponents(url: config.authEndpoint, resolvingAgainstBaseURL: false)!
        var items: [URLQueryItem] = [
            .init(name: "response_type", value: "code"),
            .init(name: "client_id", value: config.clientId),
            .init(name: "redirect_uri", value: config.redirectURI),
            .init(name: "scope", value: config.scopes.joined(separator: " ")),
            .init(name: "state", value: UUID().uuidString)
        ]
        if config.usePKCE {
            items.append(.init(name: "code_challenge", value: pkce.challenge))
            items.append(.init(name: "code_challenge_method", value: pkce.method))
        }
        components.queryItems = items
        let authURL = components.url!
        onLog?("Auth URL: \(authURL.absoluteString)")

        let callbackURL = await presentWebAuth(url: authURL)
        guard let callbackURL else {
            onLog?("Auth: no callback URL returned (user cancelled or error).")
            return
        }
        onLog?("Callback: \(callbackURL.absoluteString)")

        guard let code = URLComponents(url: callbackURL, resolvingAgainstBaseURL: false)?
                .queryItems?.first(where: { $0.name == "code" })?.value else {
            onLog?("Auth: no code in callback.")
            return
        }
        await exchangeCode(code, verifier: pkce.verifier)
    }

    func refreshAccessToken() async {
        guard let refreshToken else {
            onLog?("Refresh: no refresh_token cached. Sign in first.")
            return
        }
        var req = URLRequest(url: config.tokenEndpoint)
        req.httpMethod = "POST"
        req.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        req.httpBody = formEncode([
            "grant_type": "refresh_token",
            "refresh_token": refreshToken,
            "client_id": config.clientId
        ])
        await postAndLog(req, label: "refresh")
    }

    private func exchangeCode(_ code: String, verifier: String) async {
        var req = URLRequest(url: config.tokenEndpoint)
        req.httpMethod = "POST"
        req.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        var fields: [String: String] = [
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": config.redirectURI,
            "client_id": config.clientId
        ]
        if config.usePKCE { fields["code_verifier"] = verifier }
        req.httpBody = formEncode(fields)
        await postAndLog(req, label: "exchange")
    }

    private func postAndLog(_ req: URLRequest, label: String) async {
        do {
            let (data, response) = try await URLSession.shared.data(for: req)
            let status = (response as? HTTPURLResponse)?.statusCode ?? -1
            onLog?("\(label): HTTP \(status)")
            if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                for (k, v) in json {
                    let display = (k == "id_token" || k == "access_token" || k == "refresh_token")
                        ? "\(String(describing: v).prefix(24))…"
                        : "\(v)"
                    onLog?("  \(k): \(display)")
                }
                if let rt = json["refresh_token"] as? String { self.refreshToken = rt }
                if let id = json["id_token"] as? String { decodeAndLogIDToken(id) }
            } else {
                onLog?("  body: \(String(data: data, encoding: .utf8) ?? "<binary>")")
            }
        } catch {
            onLog?("\(label) failed: \(error.localizedDescription)")
        }
    }

    private func decodeAndLogIDToken(_ jwt: String) {
        // id_token is JWS compact: header.payload.signature — base64URL-decode the payload only.
        let parts = jwt.split(separator: ".")
        guard parts.count >= 2 else { return }
        let payload = String(parts[1])
        guard let data = Data(base64URLEncoded: payload),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return
        }
        onLog?("id_token claims:")
        for (k, v) in json {
            onLog?("  \(k): \(v)")
        }
    }

    private func formEncode(_ fields: [String: String]) -> Data {
        let pairs = fields
            .map { "\($0.key)=\($0.value.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? $0.value)" }
            .joined(separator: "&")
        return Data(pairs.utf8)
    }

    @MainActor
    private func presentWebAuth(url: URL) async -> URL? {
        await withCheckedContinuation { continuation in
            let session = ASWebAuthenticationSession(
                url: url,
                callbackURLScheme: config.callbackURLScheme
            ) { url, _ in
                continuation.resume(returning: url)
            }
            session.presentationContextProvider = self
            session.prefersEphemeralWebBrowserSession = true
            self.session = session
            session.start()
        }
    }

    // MARK: ASWebAuthenticationPresentationContextProviding

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        NSApplication.shared.windows.first ?? ASPresentationAnchor()
    }
}

private extension Data {
    init?(base64URLEncoded s: String) {
        var t = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while t.count % 4 != 0 { t.append("=") }
        self.init(base64Encoded: t)
    }
}
