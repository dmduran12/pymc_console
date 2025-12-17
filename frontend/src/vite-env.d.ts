/// <reference types="vite/client" />

// CSS imports
declare module '*.css' {
  const content: string;
  export default content;
}

// Image imports
declare module '*.gif' {
  const src: string;
  export default src;
}

declare module '*.png' {
  const src: string;
  export default src;
}

declare module '*.jpg' {
  const src: string;
  export default src;
}

declare module '*.svg' {
  const src: string;
  export default src;
}
