export interface StreamHandlerCallbacks {
    onToken: (token: string) => void;
    onToolStart?: (toolName: string) => void;
    onToolEnd?: (toolName: string, result: string) => void;
}

export class StreamHandler {
    name = 'aiwriter_stream';
    private _disabled = false;

    constructor(private callbacks: StreamHandlerCallbacks) {
    }

    disable(): void {
        this._disabled = true;
        this.callbacks = { onToken: () => {} };
    }

    async handleLLMNewToken(token: string): Promise<void> {
        if (this._disabled) {return;}
        if (token && this.callbacks.onToken) {
            this.callbacks.onToken(token);
        }
    }

}
