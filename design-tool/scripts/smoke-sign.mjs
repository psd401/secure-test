import { SignJWT, exportJWK, generateKeyPair } from "jose";

const { privateKey, publicKey } = await generateKeyPair("RS256");
const publicJwk = await exportJWK(publicKey);
publicJwk.kid = "smoke-kid";
publicJwk.alg = "RS256";
publicJwk.use = "sig";

// Slice 77: Google-shaped claims; role derives from the email domain.
// SMOKE_EMAIL=someone@edtools.psd401.net mints a student instead.
const token = await new SignJWT({
  email: process.env.SMOKE_EMAIL ?? "smoke.teacher@psd401.net",
  email_verified: true,
  hd: (process.env.SMOKE_EMAIL ?? "smoke.teacher@psd401.net").split("@")[1],
})
  .setProtectedHeader({ alg: "RS256", kid: "smoke-kid" })
  .setIssuer("https://smoke.example.com")
  .setAudience("smoke-client")
  .setSubject("smoke-teacher-001")
  .setIssuedAt()
  .setExpirationTime("5m")
  .sign(privateKey);

console.log(
  JSON.stringify({
    id_token: token,
    test_issuer: "https://smoke.example.com",
    test_jwks: { keys: [publicJwk] },
  }),
);
