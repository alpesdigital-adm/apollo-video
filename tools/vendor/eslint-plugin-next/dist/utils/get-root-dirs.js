"use strict";
Object.defineProperty(exports, "__esModule", {
    value: true
});
Object.defineProperty(exports, "getRootDirs", {
    enumerable: true,
    get: function() {
        return getRootDirs;
    }
});
var _tinyglobby = require("tinyglobby");
/**
 * Process a Next.js root directory glob.
 */ var processRootDir = function(rootDir) {
    return (0, _tinyglobby.globSync)(rootDir.replace(/\\/g, '/'), {
        onlyDirectories: true,
        expandDirectories: false
    }).map(function(dir) {
        return dir.length > 1 && !/^[A-Za-z]:\/$/.test(dir) ? dir.replace(/\/$/, '') : dir;
    });
};
var getRootDirs = function(context) {
    var rootDirs = [
        context.cwd
    ];
    var nextSettings = context.settings.next || {};
    var rootDir = nextSettings.rootDir;
    if (typeof rootDir === 'string') {
        rootDirs = processRootDir(rootDir);
    } else if (Array.isArray(rootDir)) {
        rootDirs = rootDir.map(function(dir) {
            return typeof dir === 'string' ? processRootDir(dir) : [];
        }).flat();
    }
    return rootDirs;
};
