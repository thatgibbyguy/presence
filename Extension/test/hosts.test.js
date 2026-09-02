import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeHost, hostMatches, registrableDomain, isIpLiteral } from "../src/lib/hosts.js";

test("normalizeHost lowercases, strips port, trailing dot, and www.", () => {
  assert.equal(normalizeHost("WWW.Reddit.COM"), "reddit.com");
  assert.equal(normalizeHost("reddit.com:8080"), "reddit.com");
  assert.equal(normalizeHost("reddit.com."), "reddit.com");
  assert.equal(normalizeHost("https://www.reddit.com:443/r/adops?x=1"), "reddit.com");
  assert.equal(normalizeHost("[::1]:8080"), "::1");
  assert.equal(normalizeHost(""), "");
  assert.equal(normalizeHost(null), "");
});

test("hostMatches: exact and subdomain", () => {
  assert.equal(hostMatches("reddit.com", "reddit.com"), true);
  assert.equal(hostMatches("old.reddit.com", "reddit.com"), true);
  assert.equal(hostMatches("a.b.reddit.com", "reddit.com"), true);
});

test("hostMatches: www. stripping and port stripping", () => {
  assert.equal(hostMatches("www.reddit.com", "reddit.com"), true);
  assert.equal(hostMatches("reddit.com", "www.reddit.com"), true);
  assert.equal(hostMatches("reddit.com:8443", "reddit.com"), true);
  assert.equal(hostMatches("https://old.reddit.com/r/x", "reddit.com"), true);
});

test("hostMatches: no partial match", () => {
  assert.equal(hostMatches("notreddit.com", "reddit.com"), false);
  assert.equal(hostMatches("reddit.com.evil.net", "reddit.com"), false);
  assert.equal(hostMatches("reddit.co", "reddit.com"), false);
});

test("hostMatches: IP literals never match", () => {
  assert.equal(hostMatches("10.0.0.1", "10.0.0.1"), false);
  assert.equal(hostMatches("10.0.0.1", "0.0.1"), false);
  assert.equal(hostMatches("::1", "::1"), false);
  assert.equal(isIpLiteral("192.168.1.1"), true);
  assert.equal(isIpLiteral("999.1.1.1"), false);
  assert.equal(isIpLiteral("reddit.com"), false);
});

test("registrableDomain: eTLD+1", () => {
  assert.equal(registrableDomain("old.reddit.com"), "reddit.com");
  assert.equal(registrableDomain("reddit.com"), "reddit.com");
  assert.equal(registrableDomain("www.reddit.com"), "reddit.com");
  assert.equal(registrableDomain("www.bbc.co.uk"), "bbc.co.uk");
  assert.equal(registrableDomain("news.bbc.co.uk"), "bbc.co.uk");
  assert.equal(registrableDomain("highway.atlassian.net"), "atlassian.net");
  assert.equal(registrableDomain("ads.reddit.com"), "reddit.com");
  assert.equal(registrableDomain("Reddit.COM."), "reddit.com");
});

test("registrableDomain: null for localhost, IPs, single labels, bare suffixes", () => {
  assert.equal(registrableDomain("localhost"), null);
  assert.equal(registrableDomain("10.0.0.1"), null);
  assert.equal(registrableDomain("[::1]"), null);
  assert.equal(registrableDomain("intranet"), null);
  assert.equal(registrableDomain("co.uk"), null);
  assert.equal(registrableDomain(""), null);
});
