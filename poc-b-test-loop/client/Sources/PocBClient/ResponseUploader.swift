import Foundation

// POSTs responses to the stub API Gateway endpoint deployed by ../infra/.
// The endpoint URL is read from the POCB_API_URL env var at launch — set it
// to the API Gateway invoke URL after `cdk deploy`.

actor ResponseUploader {
    private let endpoint: URL?
    private let session: URLSession

    init() {
        if let raw = ProcessInfo.processInfo.environment["POCB_API_URL"],
           let url = URL(string: raw) {
            self.endpoint = url
        } else {
            self.endpoint = nil
        }
        self.session = URLSession(configuration: .default)
    }

    func upload(_ response: Response) async {
        guard let endpoint else {
            print("[upload] POCB_API_URL not set — would have posted: \(response)")
            return
        }
        var req = URLRequest(url: endpoint)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        do {
            req.httpBody = try encoder.encode(response)
            let (_, urlResponse) = try await session.data(for: req)
            if let http = urlResponse as? HTTPURLResponse {
                print("[upload] \(http.statusCode) for item \(response.itemId)")
            }
        } catch {
            print("[upload] failed for item \(response.itemId): \(error)")
        }
    }
}
