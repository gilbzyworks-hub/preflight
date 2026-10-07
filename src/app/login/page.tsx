"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";

export default function Login() {
  const router = useRouter();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [state, setState] = useState<"idle" | "working" | "sent" | "error">("idle");
  const [msg, setMsg] = useState("");
  const urlError = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("error") : null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setState("working");
    const auth = supabase().auth;
    const { data, error } = mode === "signin" ? await auth.signInWithPassword({ email, password }) : await auth.signUp({ email, password });
    if (error) {
      setState("error");
      setMsg(error.message);
    } else if (data.session) {
      router.replace("/");
    } else {
      // Only happens if the project requires email confirmation.
      setState("sent");
    }
  }

  async function sendLink() {
    if (!email) { setState("error"); setMsg("Enter your email first."); return; }
    setState("working");
    const { error } = await supabase().auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${window.location.origin}/auth/callback`, shouldCreateUser: true },
    });
    if (error) {
      setState("error");
      setMsg(error.message);
    } else setState("sent");
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-5 px-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Preflight</h1>
        <p className="mt-1 text-sm text-muted">A personal pre-trade checklist for Solana meme coins.</p>
      </div>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <label className="text-sm text-muted" htmlFor="email">Email</label>
        <input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} className="field" autoComplete="email" />
        <label className="text-sm text-muted" htmlFor="password">Password {mode === "signup" && <span className="label">(at least 8 characters)</span>}</label>
        <input id="password" type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} className="field" autoComplete={mode === "signin" ? "current-password" : "new-password"} />
        <button className="btn btn-primary" disabled={state === "working"}>
          {state === "working" ? "Working…" : mode === "signin" ? "Sign in" : "Create account"}
        </button>
        <button type="button" className="btn btn-sm" onClick={() => { setMode(mode === "signin" ? "signup" : "signin"); setState("idle"); }}>
          {mode === "signin" ? "New here? Create an account" : "Already have an account? Sign in"}
        </button>
      </form>
      <div className="border-t border-line pt-4">
        <button type="button" className="btn btn-sm w-full" onClick={sendLink} disabled={state === "working"}>Email me a sign-in link instead</button>
        <p className="mt-2 text-xs text-muted">Links may be limited to a few per hour by the email service. Passwords have no limit.</p>
      </div>
      {state === "sent" && <p className="text-sm text-muted" role="status">Check your inbox for the link.</p>}
      {state === "error" && <p className="text-sm text-warn" role="alert">! {msg}</p>}
      {urlError && <p className="text-sm text-warn" role="alert">! {urlError === "not_allowed" ? "That email is not allowed for this site." : "The sign-in link was invalid or expired."}</p>}
      <p className="text-xs text-muted">Decision-support only, not financial advice. Meme coins can lose most or all of their value quickly.</p>
    </main>
  );
}
