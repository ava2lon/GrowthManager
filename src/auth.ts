import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import {compare} from "bcryptjs";
import {z} from "zod";
import {db} from "@/lib/db";
import {consumeRateLimit, getClientIp} from "@/lib/rate-limit";

const schema = z.object({email: z.email(), password: z.string().min(1)});

export const {handlers, auth, signIn, signOut} = NextAuth({
  session: {strategy: "jwt"},
  pages: {signIn: "/sign-in"},
  providers: [
    Credentials({
      credentials: {
        email: {label: "Email", type: "email"},
        password: {label: "Password", type: "password"},
      },
      async authorize(raw, request) {
        const ip = getClientIp(request);
        const ipLimit = await consumeRateLimit(`login:ip:${ip}`, 10, 15 * 60);
        if (!ipLimit.allowed) return null;

        const parsed = schema.safeParse(raw);
        if (!parsed.success) return null;

        const email = parsed.data.email.toLowerCase().trim();
        const emailLimit = await consumeRateLimit(`login:email:${email}`, 10, 15 * 60);
        if (!emailLimit.allowed) return null;

        const emailIpLimit = await consumeRateLimit(
          `login:email-ip:${email}:${ip}`,
          10,
          15 * 60,
        );
        if (!emailIpLimit.allowed) return null;

        const user = await db.user.findUnique({where: {email}});
        if (!user || !(await compare(parsed.data.password, user.passwordHash))) {
          return null;
        }

        return {id: user.id, email: user.email, name: user.name};
      },
    }),
  ],
  callbacks: {
    async jwt({token, user}) {
      if (user?.id) token.sub = user.id;
      return token;
    },
    async session({session, token}) {
      if (session.user && token.sub) session.user.id = token.sub;
      return session;
    },
  },
});
