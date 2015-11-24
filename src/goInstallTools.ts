/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

'use strict';

import vscode = require('vscode');
import fs = require('fs');
import path = require('path');
import os = require('os');
import cp = require('child_process');
import { showGoStatus, hideGoStatus } from './goStatus'
import { getBinPath } from './goPath'

export function setupGoPathAndOfferToInstallTools() {
	// TODO: There should be a better way to do this?
	var gopath = vscode.workspace.getConfiguration('go')['gopath'];
		
	// Make sure GOPATH is set
	if (gopath) {
		process.env["GOPATH"] = gopath;
	}

	if (!process.env["GOPATH"]) {
		var info = "GOPATH is not set as an environment variable or via `go.gopath` setting in Code";
		showGoStatus("GOPATH not set", "go.gopathinfo", info);
		vscode.commands.registerCommand("go.gopathinfo", () => {
			vscode.window.showInformationMessage(info);
			hideGoStatus()
		});
		return;
	}

	// Offer to install any missing tools
	var tools: { [key: string]: string } = {
		gorename: "golang.org/x/tools/cmd/gorename",
		gocode: "github.com/nsf/gocode",
		goreturns: "sourcegraph.com/sqs/goreturns",
		godef: "github.com/rogpeppe/godef",
		golint: "github.com/golang/lint/golint",
		"go-find-references": "github.com/lukehoban/go-find-references",
		"go-outline": "github.com/lukehoban/go-outline"
	}
	var keys = Object.keys(tools)
	Promise.all(keys.map(tool => new Promise<string>((resolve, reject) => {
		let toolPath = getBinPath(tool);
		fs.exists(toolPath, exists => {
			resolve(exists ? null : tools[tool])
		});
	}))).then(res => {
		var missing = res.filter(x => x != null);
		if (missing.length > 0) {
			showGoStatus("Analysis Tools Missing", "go.promptforinstall", "Not all Go tools are available on the GOPATH");
			vscode.commands.registerCommand("go.promptforinstall", () => {
				promptForInstall(missing);
				hideGoStatus();
			});
		}
	});

	function promptForInstall(missing: string[]) {

		var item = {
            title: "Install",
            command() {
				var channel = vscode.window.createOutputChannel('Go');
				channel.show();
                missing.forEach(tool => {
					cp.exec("go get -u -v " + tool, { env: process.env }, (err, stdout, stderr) => {
							channel.append(stdout.toString())
							channel.append(stderr.toString())
							if (err) {
								channel.append('exec error: ' + err)
							}
						})
                });
            }
        };
		vscode.window.showInformationMessage("Some Go analysis tools are missing from your GOPATH.  Would you like to install them?", item).then(selection => {
            if (selection) {
                selection.command();
            }
        });
	}
}