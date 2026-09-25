export declare const XML_NS = "http://www.w3.org/XML/1998/namespace";
export interface XmlNode {
    name: string;
    namespace: string;
    attributes: Record<string, string>;
    children: Array<XmlNode | string>;
}
export interface XmlParseOptions {
    readonly maxDepth?: number;
    readonly maxNodes?: number;
}
/** Bounded XML subset without DTD/entity declarations. Callers must also bound source byte length. */
export declare function parseXml(source: string, options?: XmlParseOptions): XmlNode;
export declare function xmlEscape(value: string): string;
