// The approval card's masking is at least the server's audit redact(): the same output wherever the server set is
// the whole story, and every secret of the corpus gone (quoted header values too, which the server set leaves).
import { describe, expect, it } from 'vitest';
import { redact } from '../../../../server/src/bots/policy/classify';
import { maskSecrets, redactLikeServer } from './mask';

// built at run time so no secret-looking literal sits in the source
const S = (n: number) => ['z', 'Q', String(n), 'x', 'W', '7', 'k'].join('') + 'v'.repeat(n % 5 + 4);

const corpus: { text: string; secrets: string[] }[] = [
  { text: `curl -u admin:${S(1)} https://x.com/a`, secrets: [S(1)] },
  { text: `curl --user 'admin:${S(2)}' https://x.com/a`, secrets: [S(2)] },
  { text: `mysql -h db -u root -p${S(3)} app`, secrets: [S(3)] },
  { text: `sshpass -p ${S(4)} ssh me@host`, secrets: [S(4)] },
  { text: `gh api --auth-token ${S(5)} /user`, secrets: [S(5)] },
  { text: `tool --password "${S(6)} with space" run`, secrets: [S(6)] },
  { text: `curl -H 'Authorization: Bearer ${S(7)}' https://x.com`, secrets: [S(7)] },
  { text: `curl -H "Cookie: sid=${S(8)}" https://x.com`, secrets: [S(8)] },
  { text: `https://me:${S(9)}@git.example.com/repo.git`, secrets: [S(9)] },
  { text: `https://x.com/cb?access_token=${S(10)}&x=1`, secrets: [S(10)] },
  { text: `export PRIVATE_KEY=${S(11)} AWS_ACCESS_KEY=${S(12)}`, secrets: [S(11), S(12)] },
  { text: `{"private_key": "${S(13)}", "access_key": "${S(14)}"}`, secrets: [S(13), S(14)] },
  { text: `use sk-${S(15)} and ghp_${S(16)}`, secrets: [S(15), S(16)] },
];
// quoted headers in a JSON body / MCP params: beyond the server set
const quoted: { text: string; secrets: string[] }[] = [
  { text: `{\n  "headers": {\n    "Authorization": "Basic ${S(17)}",\n    "Cookie": "sid=${S(18)}; t=1"\n  }\n}`, secrets: [S(17), S(18)] },
  { text: JSON.stringify({ body: JSON.stringify({ 'X-Api-Key': S(19) }) }), secrets: [S(19)] },
  { text: `{'authorization': 'Token ${S(20)}'}`, secrets: [S(20)] },
];

describe('maskSecrets', () => {
  it('the copy of the server set is the server set (same output on the corpus)', () => {
    for (const { text } of [...corpus, ...quoted]) expect(redactLikeServer(text), text).toBe(redact(text));
  });
  it('where the server set is the whole story, the same output as the server', () => {
    for (const { text } of corpus) expect(maskSecrets(text), text).toBe(redact(text));
  });
  it('every secret of the corpus is gone, quoted header values too', () => {
    for (const { text, secrets } of [...corpus, ...quoted]) for (const s of secrets) expect(maskSecrets(text), text).not.toContain(s);
  });
  it('keeps what is not a secret', () => {
    expect(maskSecrets('curl https://api.example.com/x -d a=1')).toBe('curl https://api.example.com/x -d a=1');
    expect(maskSecrets('{"channel": "C1", "text": "the build is red"}')).toBe('{"channel": "C1", "text": "the build is red"}');
  });
});
