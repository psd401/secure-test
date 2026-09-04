import type { Metadata } from "next";
import Image from "next/image";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { authErrorCopy } from "@/lib/ui/errorCopy";

export const metadata: Metadata = { title: "Sign in" };

interface LoginPageProps {
  searchParams: Promise<{ error?: string; next?: string }>;
}

function GoogleMark() {
  return (
    <svg viewBox="0 0 48 48" aria-hidden="true" className="size-4">
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  );
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const params = await searchParams;
  const error = params.error;
  const next = params.next;
  const copy = error ? authErrorCopy(error) : null;
  // A student who reached the dashboard is signed in correctly to the wrong
  // kind of account: the way out is Sign out, not another Google round-trip.
  const isStudentAccount = error === "student_account";

  const startHref = next
    ? `/api/auth/start?next=${encodeURIComponent(next)}`
    : "/api/auth/start";

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-16">
      <Card>
        <CardContent className="flex flex-col items-start gap-5 px-8 py-4">
          <Image
            src="/brand/psd-emblem-2color.png"
            alt="Peninsula School District"
            width={56}
            height={56}
            priority
          />
          <div>
            <h1 className="text-2xl font-semibold">Sign in to Secure-Test</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Peninsula School District staff.
            </p>
          </div>

          {copy ? (
            <Alert variant="destructive">
              <AlertTitle>{copy.message}</AlertTitle>
              {copy.showCode ? (
                <AlertDescription>
                  <code className="text-xs">{error}</code>
                </AlertDescription>
              ) : null}
            </Alert>
          ) : null}

          {isStudentAccount ? (
            <form action="/api/auth/logout" method="post" className="w-full">
              <Button type="submit" size="lg" className="w-full">
                Sign out
              </Button>
            </form>
          ) : (
            <Button asChild variant="outline" size="lg" className="w-full bg-card">
              <a href={startHref}>
                <GoogleMark />
                Sign in with Google
              </a>
            </Button>
          )}

          <p className="text-xs text-muted-foreground">
            You&apos;ll be sent to Google. Use your psd401.net account.
          </p>
        </CardContent>
      </Card>
    </main>
  );
}
