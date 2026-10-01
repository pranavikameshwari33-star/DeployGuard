/**
 * Stage 3: dashboard URLs that keep the repository context (the switcher's
 * ?repo=) when following a link. Only ids are interpolated, and only after
 * they were validated as numbers by the page.
 */
export type Links = {
  home: () => string;
  repo: (githubRepositoryId: string) => string;
  deployment: (id: string) => string;
  incident: (id: string) => string;
  page: (offset: number) => string;
  memory: (deploymentId: string) => string;
};

export function makeLinks(repo: string | null): Links {
  const q = (params: Record<string, string>) => {
    const search = new URLSearchParams({ ...(repo ? { repo } : {}), ...params }).toString();
    return search ? `/?${search}` : "/";
  };
  return {
    home: () => q({}),
    repo: (githubRepositoryId) => `/?${new URLSearchParams({ repo: githubRepositoryId })}`,
    deployment: (id) => q({ id }),
    incident: (id) => q({ incident: id }),
    page: (offset) => q(offset > 0 ? { offset: String(offset) } : {}),
    memory: (deploymentId) => `${q({ id: deploymentId, memory: "1" })}#memory`,
  };
}
