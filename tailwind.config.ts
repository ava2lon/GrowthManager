import type {Config} from "tailwindcss";
const config:Config={content:["./src/**/*.{js,ts,jsx,tsx,mdx}"],theme:{extend:{colors:{background:"hsl(var(--background))",foreground:"hsl(var(--foreground))",muted:"hsl(var(--muted))",border:"hsl(var(--border))",primary:"hsl(var(--primary))"},boxShadow:{soft:"0 12px 40px rgba(15,23,42,.06)"}}},plugins:[]};
export default config;
