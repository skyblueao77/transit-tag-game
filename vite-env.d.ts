/// <reference types="vite/client" />

declare module 'qrcode-svg' {
  interface QRCodeOptions {
    content: string;
    padding?: number;
    width?: number;
    height?: number;
    color?: string;
    background?: string;
    ecl?: 'L' | 'M' | 'H' | 'Q';
    join?: boolean;
    container?: string;
    xmlDeclaration?: boolean;
  }
  export default class QRCode {
    constructor(options: string | QRCodeOptions);
    svg(): string;
  }
}
