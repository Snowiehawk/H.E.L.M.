import { AnsiMatchingView } from "./diagnostics";

export type LoopbackUrlResult = { ok: true; url: string } | { ok: false; reason: string };
export interface OutputLink {
  label: string;
  target: string;
  allowed: boolean;
  reason?: string;
}

/** Validate again at native activation: a rendered link grants no authority. */
export function validateLoopbackUrl(target: string): LoopbackUrlResult {
  if (
    target.length > 4096 ||
    !target ||
    // eslint-disable-next-line no-control-regex -- Reject literal terminal controls at the URL boundary.
    /[\s\u0000-\u001f\u007f-\u009f\\]/u.test(target) ||
    /%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(target)
  )
    return { ok: false, reason: "The link contains unsupported whitespace, controls or escapes." };
  // Restrict original authority as well as parsed hostname: URL normalizes 127.1,
  // decimal IPv4 and escaped hostnames, which are outside this explicit policy.
  if (!/^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]{1,5})?(?:[/?#]|$)/i.test(target))
    return { ok: false, reason: "Only http(s) links to localhost, 127.0.0.1 or [::1] can open." };
  try {
    const url = new URL(target);
    if (
      url.username ||
      url.password ||
      (url.port && (Number(url.port) < 1 || Number(url.port) > 65535))
    )
      return { ok: false, reason: "Credentials and invalid ports are not allowed in local links." };
    return { ok: true, url: url.href };
  } catch {
    return { ok: false, reason: "The local URL is malformed." };
  }
}

function makeLink(label: string, target: string): OutputLink {
  const validated = validateLoopbackUrl(target);
  return {
    label,
    target,
    allowed: validated.ok,
    reason: validated.ok ? undefined : validated.reason,
  };
}

/** Bounded matching of complete retained output; OSC8 labels never replace targets. */
export function parseOutputLinks(output: string): OutputLink[] {
  const text = output.slice(-262_144);
  const links: OutputLink[] = [];
  const seen = new Set<string>();
  const add = (label: string, target: string) => {
    const key = JSON.stringify([label, target]);
    if (links.length < 256 && !seen.has(key)) {
      seen.add(key);
      links.push(makeLink(label, target));
    }
  };
  const osc =
    // eslint-disable-next-line no-control-regex -- OSC8 is defined using ESC/BEL control delimiters.
    /\u001b\]8;[^;\u0007\u001b]*;([^\u0007\u001b]{1,4096})(?:\u0007|\u001b\\)([\s\S]*?)\u001b\]8;[^;\u0007\u001b]*;(?:\u0007|\u001b\\)/g;
  let match: RegExpExecArray | null;
  while ((match = osc.exec(text)))
    add(new AnsiMatchingView().push(match[2]).slice(0, 4096), match[1]);
  // Do not manufacture an independent destination from a deceptive OSC8 label.
  const plain = new AnsiMatchingView().push(text.replace(osc, ""));
  // eslint-disable-next-line no-control-regex -- Matching excludes literal terminal controls.
  for (const result of plain.matchAll(/https?:\/\/[^\s<>"'\u0000-\u001f\u007f-\u009f]+/gi)) {
    let target = result[0].replace(/[.,;!?]+$/, "");
    // Common prose wrappers; preserve balanced parentheses in real URL paths.
    while (
      target.endsWith(")") &&
      (target.match(/\)/g)?.length ?? 0) > (target.match(/\(/g)?.length ?? 0)
    )
      target = target.slice(0, -1);
    add(target, target);
  }
  return links;
}
