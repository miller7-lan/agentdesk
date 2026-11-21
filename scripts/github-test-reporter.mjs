// node --test reporter for GitHub Actions: every failing test becomes an ::error annotation (file, line,
// name and message), so failures are readable from the public check-run annotations without log access.
const clean = (text) => String(text ?? '').replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A').slice(0, 1500);

export default async function* githubReporter(source) {
  for await (const event of source) {
    if (event.type !== 'test:fail') continue;
    const data = event.data || {};
    if (data.details?.type === 'suite') continue;
    const error = data.details?.error;
    const cause = error?.cause ?? error;
    const message = [cause?.message || String(cause || 'failed'), cause?.expected !== undefined ? `expected: ${JSON.stringify(cause.expected)}` : '',
      cause?.actual !== undefined ? `actual: ${JSON.stringify(cause.actual)}` : '', (cause?.stack || '').split('\n').slice(1, 4).join(' | ')]
      .filter(Boolean).join(' — ');
    const file = data.file ? data.file.replace(/\\/g, '/').replace(/^.*?\/test\//, 'test/') : '';
    yield `::error${file ? ` file=${file},line=${data.line || 1}` : ''}::${clean(data.name)}: ${clean(message)}\n`;
  }
}
