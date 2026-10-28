declare module 'safe-regex' {
  interface SafeRegexOptions {
    limit?: number;
  }

  export default function safeRegex(pattern: RegExp | string, options?: SafeRegexOptions): boolean;
}
