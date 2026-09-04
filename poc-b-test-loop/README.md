# PoC-B — Test Delivery Loop

## Status

**Pass** as of 2026-05-19. End-to-end vertical slice deployed to PSD playground AWS account and verified. See [RESULTS.md](./RESULTS.md). Stack is left running; teardown command at the bottom of RESULTS.md.

## Question this answers

Can the macOS client render a JSON test item in a sandboxed `WKWebView`, capture the student's answer via a single JS message handler, and POST it to AWS — without the WebView being able to escape the sandbox? And is the round-trip latency acceptable?

## Pass / fail

- **Pass**: launch `PocBClient`, see three questions, click answers, observe each `POST /responses` succeed (HTTP 202) and the JSON payload in the Lambda's CloudWatch log group.
- **Pass also**: verify the WebView blocks `window.open`, blocks loading any remote URL (CSP `default-src 'none'`), and does not surface a right-click context menu when launched.
- **Fail**: any of the above doesn't hold.

## Layout

```
poc-b-test-loop/
├── client/                       # Swift macOS app
│   ├── Package.swift
│   └── Sources/PocBClient/
│       ├── main.swift
│       ├── AppDelegate.swift
│       ├── TestRunner.swift      # WKWebView + JS bridge
│       ├── ItemModel.swift       # Codable models + bundle loader
│       ├── ResponseUploader.swift
│       └── Resources/items.json  # bundled 3-item test
└── infra/                        # CDK stack (TS, bun-friendly)
    ├── package.json
    ├── cdk.json
    ├── tsconfig.json
    ├── bin/poc-b.ts
    ├── lib/poc-b-stack.ts        # API GW + Lambda + log group
    └── lambda/response-intake.ts # logs incoming JSON to CloudWatch
```

## Setup

### 1. Deploy infra

```
cd infra
bun install
bunx cdk bootstrap   # only once per account/region
bunx cdk deploy
```

Copy the `ApiUrl` from the stack output.

### 2. Run client

```
cd ../client
export POCB_API_URL="https://...execute-api.../poc/responses"
swift run
```

If `POCB_API_URL` is unset the client logs each response to stdout instead of uploading — useful for offline test runs.

### 3. Observe

- Pick answers in the window.
- In another terminal: `aws logs tail /aws/lambda/SecureTestPocB-ResponseIntakeFn... --follow`.
- Verify each response object lands in the log.

## Teardown

```
cd infra
bunx cdk destroy
```

## What this PoC is NOT

- Not authenticated — the API is open. Anyone with the URL can post. Fine for PoC.
- Not persistent — the Lambda only logs; nothing in DynamoDB or S3.
- Not stylistic — the test renders in raw HTML with a minimal `font` declaration.
- Not graded — the client knows the correct answer but doesn't grade; that's MVP work.

## Open questions surfaced by this PoC

To record after the spike:

- Can the WebView's JS context be reached by anything other than the bundled inline script? Try paste, drag, links, devtools.
- What's the actual round-trip latency from click to Lambda log?
- Does the item schema in `items.json` survive contact with real assessment content (math, images, longer stems)?
- Is the CSP strict enough? Should we go beyond and use a content scheme handler?
