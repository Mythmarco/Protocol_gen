import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { createAdminClient } from "@/utils/supabase/admin";
import { createSession } from "@/lib/session";

// POST /api/auth/signin
// Body: { email, password }
// Verifies against Stacklabs User table (bcrypt + role=ADMIN). Sets cookie.
export async function POST(req: Request) {
  const { email, password } = (await req.json()) as {
    email?: string;
    password?: string;
  };

  if (!email || !password) {
    console.log("[signin] missing email or password");
    return NextResponse.json({ error: "missing_credentials" }, { status: 400 });
  }

  const supabase = createAdminClient();

  // Try to find the user. We log fine-grained reasons to the server console
  // so you can debug from the terminal — the response body stays generic.
  const { data: user, error } = await supabase
    .from("User")
    .select("id, email, password, role, name")
    .ilike("email", email.trim())
    .maybeSingle();

  if (error) {
    console.error("[signin] Supabase query error:", error);
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }

  if (!user) {
    console.log(`[signin] no User row found for email='${email.trim()}'`);
    // Still hash to avoid timing side-channel
    await bcrypt.compare(password, "$2a$10$0000000000000000000000000000000000000000000000000000");
    return NextResponse.json({ error: "invalid_credentials" }, { status: 401 });
  }

  console.log(
    `[signin] found user id=${user.id} email=${user.email} role=${user.role} ` +
      `hashPrefix=${user.password?.slice(0, 7) ?? "(none)"} hashLen=${user.password?.length ?? 0}`
  );

  if (!user.password) {
    console.log("[signin] User row has no password column value");
    return NextResponse.json({ error: "invalid_credentials" }, { status: 401 });
  }

  const valid = await bcrypt.compare(password, user.password);
  console.log(`[signin] bcrypt.compare result: ${valid}`);

  if (!valid) {
    return NextResponse.json({ error: "invalid_credentials" }, { status: 401 });
  }

  if (user.role !== "ADMIN") {
    console.log(`[signin] user role is '${user.role}', not ADMIN`);
    return NextResponse.json({ error: "not_admin" }, { status: 403 });
  }

  await createSession({
    id: String(user.id),
    email: user.email,
    role: user.role,
    name: user.name ?? undefined,
  });

  console.log(`[signin] success for ${user.email}`);
  return NextResponse.json({ ok: true });
}
