// The build under test: the repository's dist/.
export const repositoryUrl = new URL('../../', import.meta.url);
export const distRoot = new URL('dist/', repositoryUrl);
export const distUrl = path => new URL(path, distRoot);
