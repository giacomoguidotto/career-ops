import { readFileSync } from 'fs';
import { join } from 'path';
import { pass, fail, ROOT } from '../helpers.mjs';

const fixture = readFileSync(join(ROOT, 'tests', 'fixtures', 'approaches', '247-founder-pack.md'), 'utf-8');
const planner = readFileSync(join(ROOT, 'modes', 'communication-planner.md'), 'utf-8');

function ok(label, condition) {
  if (condition) pass(label);
  else fail(label);
}

ok('#247 fixture uses a warm informal founder register', /informal, smart, and lightly playful/i.test(fixture) && /Hi Yonatan and Adar/.test(fixture));
ok('#247 fixture lets specific proof imply capability', /graph service from messy requirements through the data model and APIs/i.test(fixture));
ok('#247 fixture avoids a cold keyword inventory', !/skills?:|competencies:|technology stack:/i.test(fixture));
ok('#247 fixture ranks a parallel route while preserving the formal route', /## Ranked Approach Plan/.test(fixture) && /## Formal Route/.test(fixture));
ok('#247 fixture leaves the company and role title to the details page', !/^#{1,2}\s+(?:Next|Approach):/i.test(fixture));
ok('#247 fixture contains no em dash', !fixture.includes('—'));
ok('standalone planner requires generic defaults when personal strategy is absent', /generic defaults/i.test(planner) && /absence into a blocker/i.test(planner));
