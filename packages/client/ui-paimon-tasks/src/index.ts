/**
 * Paimon task strip, node half. Pure UI plugin: the empty apply exists so the
 * plugin appears in the host cordis.yml, while the browser half ships via
 * `exports["./client"]` and is discovered through the `dsh.client` manifest
 * declaration.
 */

/** Host plugin body — no host-side behaviour for this surface plugin. */
export function apply(): void {}
