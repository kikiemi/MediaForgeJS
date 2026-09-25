export type EventMessage = {
    schemeIdUri: string;
    value: string;
    timescale: number;
    eventDuration: number;
    id: number;
    messageData: Uint8Array;
} & ({
    version: 0;
    presentationTimeDelta: number;
} | {
    version: 1;
    presentationTime: bigint;
});
export declare function encodeEventMessage(event: EventMessage): Uint8Array<ArrayBuffer>;
export declare function decodeEventMessage(bytes: Uint8Array): EventMessage;
export declare function eventMessageTime(event: EventMessage, segmentStartTime?: number): number;
