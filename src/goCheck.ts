/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------*/

'use strict';

import vscode = require('vscode');
import path = require('path');
import os = require('os');
import { getGoRuntimePath } from './goPath';
import { getCoverage } from './goCover';
import { outputChannel, diagnosticsStatusBarItem } from './goStatus';
import { goTest } from './testUtils';
import { ICheckResult } from './util';
import { goLint } from './goLint';
import { goVet } from './goVet';
import { goBuild } from './goBuild';

let statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
statusBarItem.command = 'go.test.showOutput';
const neverAgain = { title: 'Don\'t Show Again' };

export function removeTestStatus(e: vscode.TextDocumentChangeEvent) {
	if (e.document.isUntitled) {
		return;
	}
	statusBarItem.hide();
	statusBarItem.text = '';
}

export function checksOnFileEdit(e: vscode.TextDocumentChangeEvent) {
	let ctx = this;
	if (e.document.isUntitled || e.document.languageId !== 'go') {
		return;
	}

	let documentUri = e ? e.document.uri : null;
	let goConfig = vscode.workspace.getConfiguration('go', documentUri);

	if ((ctx.globalState.get('ignoreGeneratedCodeWarning') !== true) && e.document.lineAt(0).text.match(/^\/\/ Code generated .* DO NOT EDIT\.$/)) {
		vscode.window.showWarningMessage('This file seems to be generated. DO NOT EDIT.', neverAgain).then(result => {
			if (result === neverAgain) {
				ctx.globalState.update('ignoreGeneratedCodeWarning', true);
			}
		});
	}

	let settingsBuildTags = goConfig['buildTags'] ? goConfig['buildTags'].split(' ') : null;
	let fileBuildTags = [];
	const openSettings = {title: 'Open settings'};

	for (let i = 0; i < e.document.lineCount; i++) {
		if (e.document.lineAt(i).text.match(/^\/\/ \+build [\w\s]+$/)) {
			fileBuildTags.push(...e.document.lineAt(i).text.split(' '));
		}
	}

	fileBuildTags = fileBuildTags.filter(tag => tag !== '+build' && tag !== '//' && tag !== '' && tag !== '//+build');

	if (fileBuildTags) {
		for (let i = 0; i < fileBuildTags.length; i++) {
			if (settingsBuildTags === null || settingsBuildTags.indexOf(fileBuildTags[i]) === -1) {
				vscode.window.showInformationMessage('Build tags mentioned in the file don not match with "go.buildTags"', neverAgain, openSettings).then(result => {
					if (result === neverAgain) {
						ctx.globalState.update('ignoreGeneratedCodeWarning', true);
					}
					if (result === openSettings) {
						vscode.commands.executeCommand('workbench.action.openGlobalSettings');
					}
				});
				return;
			}
		}
	}
}

export function check(fileUri: vscode.Uri, goConfig: vscode.WorkspaceConfiguration): Promise<ICheckResult[]> {
	diagnosticsStatusBarItem.hide();
	outputChannel.clear();
	let runningToolsPromises = [];
	let cwd = path.dirname(fileUri.fsPath);
	let goRuntimePath = getGoRuntimePath();

	if (!goRuntimePath) {
		vscode.window.showInformationMessage('Cannot find "go" binary. Update PATH or GOROOT appropriately');
		return Promise.resolve([]);
	}

	let testPromise: Thenable<boolean>;
	let tmpCoverPath;
	let runTest = () => {
		if (testPromise) {
			return testPromise;
		}

		let buildFlags = goConfig['testFlags'] || goConfig['buildFlags'] || [];

		let args = [...buildFlags];
		if (goConfig['coverOnSave']) {
			tmpCoverPath = path.normalize(path.join(os.tmpdir(), 'go-code-cover'));
			args = ['-coverprofile=' + tmpCoverPath, ...buildFlags];
		}

		testPromise = goTest({
			goConfig: goConfig,
			dir: cwd,
			flags: args,
			background: true
		});
		return testPromise;
	};

	if (!!goConfig['buildOnSave'] && goConfig['buildOnSave'] !== 'off') {
		runningToolsPromises.push(goBuild(fileUri, goConfig, goConfig['buildOnSave'] === 'workspace'));
	}

	if (!!goConfig['testOnSave']) {
		statusBarItem.show();
		statusBarItem.text = 'Tests Running';
		runTest().then(success => {
			if (statusBarItem.text === '') {
				return;
			}
			if (success) {
				statusBarItem.text = 'Tests Passed';
			} else {
				statusBarItem.text = 'Tests Failed';
			}
		});
	}

	if (!!goConfig['lintOnSave'] && goConfig['lintOnSave'] !== 'off') {
		runningToolsPromises.push(goLint(fileUri, goConfig, goConfig['lintOnSave'] === 'workspace'));
	}

	if (!!goConfig['vetOnSave'] && goConfig['vetOnSave'] !== 'off') {
		runningToolsPromises.push(goVet(fileUri, goConfig, goConfig['vetOnSave'] === 'workspace'));
	}

	if (!!goConfig['coverOnSave']) {
		runTest().then(success => {
			if (!success) {
				return [];
			}
			// FIXME: it's not obvious that tmpCoverPath comes from runTest()
			return getCoverage(tmpCoverPath);
		});
	}

	return Promise.all(runningToolsPromises).then(function (resultSets) {
		return [].concat.apply([], resultSets);
	});
}
