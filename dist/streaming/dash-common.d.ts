export interface DashFraction {
    readonly value: bigint;
    readonly scale: bigint;
}
export declare const DASH_NS = "urn:mpeg:dash:schema:mpd:2011";
export declare const DASH_U64 = 18446744073709551615n;
export declare function dashError(message: string): never;
export declare function dashLimit(value: number | undefined, fallback: number, name: string, maximum?: number): number;
export declare function dashInteger(value: string | undefined, name: string, fallback?: bigint): bigint;
export declare function dashAdd(a: DashFraction, b: DashFraction): DashFraction;
export declare function dashSubtract(a: DashFraction, b: DashFraction): DashFraction;
export declare function dashCompare(a: DashFraction, b: DashFraction): bigint;
export declare function dashSeconds(value: DashFraction): number;
export declare function dashDuration(value: string | undefined, name: string): DashFraction | undefined;
export declare function dashNumberTime(value: number, name: string): DashFraction;
export declare function dashCeil(value: bigint, denominator: bigint): bigint;
export declare function dashFloor(value: bigint, denominator: bigint): bigint;
export declare function dashUrl(value: string, base?: string): string;
export type DashTemplateToken = string | {
    readonly name: 'Number' | 'Time';
    readonly width: number;
};
export declare function dashTemplate(value: string, id: string | undefined, bandwidth: number | undefined, initialization?: boolean): readonly DashTemplateToken[];
export declare function dashExpand(tokens: readonly DashTemplateToken[], number: bigint, time: bigint): string;
