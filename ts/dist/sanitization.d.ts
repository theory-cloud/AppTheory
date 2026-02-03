export declare function sanitizeLogString(value: string): string;
export declare function maskFirstLast(value: string, prefixLen: number, suffixLen: number): string;
export declare function maskFirstLast4(value: string): string;
export declare function sanitizeFieldValue(key: string, value: unknown): unknown;
export declare function sanitizeJSON(jsonBytes: Uint8Array | string): string;
export interface XMLSanitizationPattern {
    name: string;
    pattern: RegExp;
    maskingFunc: (match: string) => string;
}
export declare function sanitizeXML(xmlString: string, patterns: XMLSanitizationPattern[]): string;
export declare const paymentXMLPatterns: XMLSanitizationPattern[];
export declare const rapidConnectXMLPatterns: XMLSanitizationPattern[];
