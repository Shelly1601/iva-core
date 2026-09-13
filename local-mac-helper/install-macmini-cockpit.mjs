import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {assertImacExecutionHost} from './imac-host-guard.mjs';
import {centralRuntimeRoot} from './central-runtime.mjs';
const exec=promisify(execFile);
const xml=v=>String(v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
export async function installMacMiniCockpit(){
 assertImacExecutionHost();
 const {stdout}=await exec('/usr/bin/security',['find-generic-password','-a','macmini-nadine','-s','de.iva.macmini-cockpit','-w']);
 if(stdout.trim().length<48)throw Error('Lokaler Cockpit-Schlüssel fehlt.');
 const label='de.iva.macmini-cockpit',domain='gui/'+process.getuid();
 const plist=path.join(os.homedir(),'Library/LaunchAgents',label+'.plist');
 const logs=path.join(os.homedir(),'Library/Application Support/IVA Mac Helper/logs');
 const program=path.join(centralRuntimeRoot(),'current/local-mac-helper/macmini-cockpit-proxy.mjs');
 await mkdir(logs,{recursive:true,mode:0o700});await mkdir(path.dirname(plist),{recursive:true,mode:0o700});
 await writeFile(plist,`<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(program)}</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>5</integer><key>StandardOutPath</key><string>${xml(path.join(logs,'cockpit.out.log'))}</string><key>StandardErrorPath</key><string>${xml(path.join(logs,'cockpit.err.log'))}</string></dict></plist>`,{mode:0o600});
 await exec('/usr/bin/plutil',['-lint',plist]);await exec('/bin/launchctl',['bootout',domain,plist]).catch(()=>{});await exec('/bin/launchctl',['bootstrap',domain,plist]);
 const launcher=path.join(os.homedir(),'Desktop/IVA Cockpit.webloc');
 await writeFile(launcher,'<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>URL</key><string>http://127.0.0.1:4318/cockpit</string></dict></plist>');
 return {installed:true,plist,cockpitUrl:'http://127.0.0.1:4318/cockpit',launcher};
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url)console.log(JSON.stringify(await installMacMiniCockpit()));
