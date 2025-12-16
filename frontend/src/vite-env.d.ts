/// <reference types="vite/client" />

// CSS imports
declare module '*.css' {
  const content: string;
  export default content;
}
