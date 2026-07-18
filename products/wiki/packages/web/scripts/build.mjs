#!/usr/bin/env node
import { buildWebAssets } from "../src/index.ts";

const manifest = await buildWebAssets();
console.log(`Built OpenWiki web assets: ${manifest.css}, ${manifest.js}`);
