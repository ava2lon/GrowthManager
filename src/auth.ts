import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import {compare} from "bcryptjs";
import {z} from "zod";
import {db} from "@/lib/db";
const schema=z.object({email:z.email(),password:z.string().min(1)});
export const {handlers,auth,signIn,signOut}=NextAuth({session:{strategy:"jwt"},pages:{signIn:"/sign-in"},providers:[Credentials({credentials:{email:{label:"Email",type:"email"},password:{label:"Password",type:"password"}},async authorize(raw){const p=schema.safeParse(raw);if(!p.success)return null;const u=await db.user.findUnique({where:{email:p.data.email.toLowerCase()}});if(!u||!(await compare(p.data.password,u.passwordHash)))return null;return{id:u.id,email:u.email,name:u.name};}})],callbacks:{async jwt({token,user}){if(user?.id)token.sub=user.id;return token;},async session({session,token}){if(session.user&&token.sub)session.user.id=token.sub;return session;}}});
