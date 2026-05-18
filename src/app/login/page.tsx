"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";

function LoginContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialError = searchParams.get("error");

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(
    initialError === "not_admin"
      ? "Este usuario no es ADMIN en Stacklabs."
      : initialError === "session_expired"
      ? "Tu sesión expiró. Inicia sesión de nuevo."
      : null
  );
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const res = await fetch("/api/auth/signin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: email.trim(), password }),
    });

    if (!res.ok) {
      let body: { error?: string } = {};
      try {
        body = await res.json();
      } catch {}
      setError(
        body.error === "not_admin"
          ? "Este usuario no es ADMIN en Stacklabs."
          : body.error === "invalid_credentials"
          ? "Correo o contraseña incorrectos."
          : "Error al iniciar sesión."
      );
      setLoading(false);
      return;
    }

    router.push("/");
    router.refresh();
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-amber-50 to-stone-100 px-4">
      <div className="bg-white rounded-2xl shadow-xl p-10 flex flex-col items-center gap-6 max-w-sm w-full">
        <div className="text-center">
          <div className="text-4xl font-bold tracking-tight text-stone-700 mb-1">
            Peptides<span className="text-amber-500">4ALL</span>
          </div>
          <p className="text-sm text-stone-500">Generador de Protocolos</p>
        </div>

        <form onSubmit={handleSubmit} className="w-full flex flex-col gap-3">
          <div>
            <label className="block text-xs font-medium text-stone-600 mb-1">
              Correo
            </label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoFocus
              autoComplete="email"
              placeholder="tu@stacklabs.com"
              className="w-full rounded-xl border border-stone-300 focus:border-amber-400 focus:outline-none px-4 py-2.5 text-sm text-stone-800 placeholder-stone-400 transition-colors"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-stone-600 mb-1">
              Contraseña
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="current-password"
              className="w-full rounded-xl border border-stone-300 focus:border-amber-400 focus:outline-none px-4 py-2.5 text-sm text-stone-800 transition-colors"
            />
          </div>

          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-3 py-2 text-center">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-amber-500 hover:bg-amber-400 disabled:opacity-60 text-white font-medium rounded-xl px-5 py-3 text-sm transition-colors mt-2"
          >
            {loading ? "Iniciando sesión..." : "Iniciar sesión"}
          </button>
        </form>

        <p className="text-xs text-stone-400 text-center">
          Usa tus credenciales de administrador de Stacklabs.
        </p>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginContent />
    </Suspense>
  );
}
