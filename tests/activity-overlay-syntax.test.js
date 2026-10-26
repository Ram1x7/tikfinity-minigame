import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
test('activity overlay browser script parses without syntax errors',()=>{
 const js=readFileSync(new URL('../overlay/activity.js',import.meta.url),'utf8').replace(/^import .*;\s*$/gm,'');
 assert.doesNotThrow(()=>new Function(js));
});
test('overlay keeps four information panels without streamer title',()=>{
 const html=readFileSync(new URL('../overlay/display.html',import.meta.url),'utf8');
 for(const id of ['calendar','likes-ranking','gift-feed','comment-feed'])assert.match(html,new RegExp('id="'+id+'"'));
 assert.doesNotMatch(html,/らみん民/);
});
