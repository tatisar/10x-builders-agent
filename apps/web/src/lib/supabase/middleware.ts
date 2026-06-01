import { createServerClient, type CookieMethodsServer } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import { getSupabaseEnv } from "./env";

export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const isSecureRequest =
    request.headers.get("x-forwarded-proto") === "https" ||
    request.nextUrl.protocol === "https:";

  const cookies: CookieMethodsServer = {
    getAll() {
      return request.cookies.getAll();
    },
    setAll(cookiesToSet, headers) {
      cookiesToSet.forEach(({ name, value }) =>
        request.cookies.set(name, value)
      );
      supabaseResponse = NextResponse.next({ request });
      cookiesToSet.forEach(({ name, value, options }) =>
        supabaseResponse.cookies.set(name, value, {
          ...options,
          secure: isSecureRequest ? true : options?.secure,
        })
      );
      Object.entries(headers).forEach(([key, value]) =>
        supabaseResponse.headers.set(key, value)
      );
    },
  };

  const { url, key } = getSupabaseEnv();

  const supabase = createServerClient(url, key, { cookies });

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;

  const publicPaths = ["/login", "/signup", "/auth/callback"];
  const isPublic = publicPaths.some((p) => pathname.startsWith(p));
  // Server-to-server routes that authenticate via their own secret header,
  // not via browser cookies — exempt from the Supabase session redirect.
  const isPublicApi =
    pathname.startsWith("/api/telegram/webhook") ||
    pathname.startsWith("/api/cron/");

  if (!user && !isPublic && !isPublicApi) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }

  if (user && (pathname === "/login" || pathname === "/signup")) {
    const url = request.nextUrl.clone();
    url.pathname = "/";
    return NextResponse.redirect(url);
  }

  return supabaseResponse;
}
