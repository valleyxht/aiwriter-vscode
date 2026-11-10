/** Incrementally hide the XML tool protocol used by compatibility providers. */
export class VisibleTextStream {
    private pending = '';
    private hiddenTag = '';
    content = '';

    push(text: string, done = false): string {
        this.pending += text;
        let output = '';
        while (this.pending) {
            if (this.hiddenTag) {
                const closing = new RegExp(`</${this.hiddenTag}\\s*>`, 'i').exec(this.pending);
                if (!closing) {
                    // Keep only a possible split closing tag, not the tool payload.
                    const last = this.pending.lastIndexOf('<');
                    this.pending = last < 0 ? '' : this.pending.slice(last);
                    break;
                }
                this.pending = this.pending.slice(closing.index + closing[0].length);
                this.hiddenTag = '';
                continue;
            }
            const start = this.pending.indexOf('<');
            if (start < 0) { output += this.pending; this.pending = ''; break; }
            output += this.pending.slice(0, start);
            this.pending = this.pending.slice(start);
            const candidate = /^<\/?(?:tool|invoke)(?:\s|>|$)|^<\/?tool_calls?(?:\s|>|$)/i.test(this.pending);
            const prefix = ['<tool', '<invoke', '<tool_call', '<tool_calls', '</tool_call', '</tool_calls']
                .some(tag => tag.startsWith(this.pending.toLowerCase()));
            const end = this.pending.indexOf('>');
            if (end < 0 && (candidate || prefix)) {
                if (done) {
                    if (this.pending === '<' || this.pending === '</') { output += this.pending; }
                    this.pending = '';
                }
                break;
            }
            if (end >= 0 && candidate) {
                const tag = this.pending.slice(0, end + 1);
                const opening = /^<(tool|invoke)\s/i.exec(tag);
                if (opening) { this.hiddenTag = opening[1]; }
                this.pending = this.pending.slice(end + 1);
                continue;
            }
            output += '<';
            this.pending = this.pending.slice(1);
        }
        this.content += output;
        return output;
    }
}
