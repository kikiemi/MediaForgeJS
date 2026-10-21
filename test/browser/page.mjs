// The browser test page: imports each test file the runner lists, runs its tests with the
// node:test of node-test.mjs and keeps the results in window.__testReport for the runner to read.
import { runFile, startFile } from './node-test.mjs';

const report = {
    done: false,
    userAgent: navigator.userAgent,
    current: undefined,
    files: [],
    pageErrors: [],
};
window.__testReport = report;
addEventListener('error', event => report.pageErrors.push(String(event.message)));
addEventListener('unhandledrejection', event =>
    report.pageErrors.push(String(event.reason?.stack ?? event.reason)),
);

const files = await (await fetch('/__files.json')).json();
for (const file of files) {
    report.current = file;
    startFile();
    let results;
    try {
        await import(`/${file}`);
        results = await runFile(name => {
            report.current = `${file} > ${name}`;
        });
    } catch (error) {
        results = [
            { name: 'the file loads', status: 'fail', error: String(error?.stack ?? error) },
        ];
    }
    report.files.push({ file, results });
}
report.current = undefined;
report.done = true;
