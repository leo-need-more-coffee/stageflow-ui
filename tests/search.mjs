/**
 * Finding a stage among many: every typed word must be found, and a hit in
 * the name ranks above one in the description.
 *
 * Run: node tests/search.mjs
 */
import { rank, score, splitName, tokensOf } from "../src/core/search.js";

let failed = 0;
let checks = 0;
function check(what, actual, expected) {
  checks++;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    failed++;
    console.error(`✗ ${what}\n    expected: ${e}\n    actual:   ${a}`);
  }
}

check("a CamelCase name splits into words, without Stage",
  splitName("LoadCustomerStage"), ["load", "customer"]);
check("snake case too", splitName("http_get_json"), ["http", "get", "json"]);
check("an acronym stays one word", splitName("HTTPRequestStage"), ["http", "request"]);

const stages = [
  { name: "LoadCustomerStage", description: "The customer's plan", category: "support.data", args: ["customer_id"] },
  { name: "LoadTicketStage", description: "Takes a ticket", category: "support.data", args: ["ticket_id"] },
  { name: "SendReplyStage", description: "Sends the reply to the customer", category: "support.reply", args: ["reply"] },
  { name: "AppendListStage", description: "Append an item", category: "builtin.lists", args: ["list", "item"] },
];
const names = (query) => rank(stages, query).map((s) => s.name);

check("the start of a name finds it", names("loadc"), ["LoadCustomerStage"]);
check("a word inside the name", names("customer")[0], "LoadCustomerStage");
check("the name ranks above the description",
  names("customer"), ["LoadCustomerStage", "SendReplyStage"]);
check("initials", names("lt"), ["LoadTicketStage"]);
check("every word must be found", names("load reply"), []);
check("words in any order", names("ticket load"), ["LoadTicketStage"]);
check("an argument name", names("item"), ["AppendListStage"]);
check("the category", names("lists"), ["AppendListStage"]);
check("nothing typed keeps the order", names("  "), stages.map((s) => s.name));
check("a word found nowhere scores nothing", score(stages[0], tokensOf("zzz")), 0);

// a few hundred stages: the right one is still first
const many = Array.from({ length: 500 }, (_, i) => ({ name: `Generated${i}Stage`, description: "filler customer text", category: "gen" }));
check("among 500 stages the named one is first",
  rank([...many, ...stages], "loadcust")[0].name, "LoadCustomerStage");

if (failed) {
  console.error(`search: ${failed} of ${checks} checks failed`);
  process.exit(1);
}
console.log(`search: ${checks} checks, a stage is found by any part of what it is`);
