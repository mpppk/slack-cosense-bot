/** Projects this bot is allowed to touch, from the COSENSE_PROJECTS var. */
export function allowedProjects(env: Env): string[] {
	return env.COSENSE_PROJECTS.split(",")
		.map((name) => name.trim())
		.filter((name) => name.length > 0);
}

export function projectUrl(env: Env, project: string): string {
	return `${env.COSENSE_ORIGIN}/${project}`;
}
