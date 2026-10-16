// Keep original cell text/quoting. Only record separators and repeated headers
// are changed; numeric-looking values are never coerced.
function records(text: string): { raw: string; cells: string[] }[] {
  const result: { raw: string; cells: string[] }[] = [];
  let start = 0, cell = '', cells: string[] = [], quoted = false, closed = false;
  for (let index = 0; index <= text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char === undefined) throw new Error('CSV contains an unclosed quoted field.');
      if (char === '"') {
        if (text[index + 1] === '"') { cell += '"'; index++; }
        else { quoted = false; closed = true; }
      } else cell += char;
      continue;
    }
    if (char === ',' || char === '\r' || char === '\n' || char === undefined) {
      cells.push(cell); cell = ''; closed = false;
      if (char === ',') continue;
      const raw = text.slice(start, index);
      if (raw !== '' || char !== undefined) result.push({ raw, cells });
      cells = [];
      if (char === '\r' && text[index + 1] === '\n') index++;
      start = index + 1;
    } else if (char === '"') {
      if (cell || closed) throw new Error('CSV contains an unexpected quote.');
      quoted = true;
    } else {
      if (closed) throw new Error('CSV contains characters after a closing quote.');
      cell += char;
    }
  }
  return result;
}

export class CsvCombiner {
  private header: string[] | undefined;
  private parts: { order: number; text: string }[] = [];
  private headerText = '';
  private count = 0;
  private dataRows = 0;
  get rowCount() { return this.dataRows; }

  append(text: string, order = this.count) {
    const bom = text.startsWith('\uFEFF');
    const rows = records(bom ? text.slice(1) : text);
    const first = rows.shift();
    if (!first || first.cells.every(cell => cell === '')) throw new Error('A CSV attachment is empty or has no header.');
    if (this.header && JSON.stringify(this.header) !== JSON.stringify(first.cells)) {
      throw new Error('CSV headers differ between chunks. Download the files separately.');
    }
    if (rows.some(row => row.cells.length !== first.cells.length)) {
      throw new Error('A CSV row has a different number of columns from its header.');
    }
    if (!this.header) {
      this.header = first.cells;
      this.headerText = (bom ? '\uFEFF' : '') + first.raw + '\r\n';
    }
    this.dataRows += rows.length;
    this.parts.push({ order, text: rows.map(row => row.raw + '\r\n').join('') });
    this.count++;
  }

  finish(): Blob {
    if (!this.count) throw new Error('No CSV attachments were combined.');
    return new Blob([this.headerText, ...[...this.parts].sort((a, b) => a.order - b.order).map(part => part.text)], { type: 'text/csv;charset=utf-8' });
  }
}
