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
var _glob = require("glob");
var _fs = require("node:fs");
/**
 * Process a Next.js root directory glob.
 */ var processRootDir = function(rootDir) {
    var pattern = rootDir.replace(/\\/g, '/');
    // fast-glob does not emit the literal base for a terminal globstar.
    // Keep zero-depth matches when the prefix itself contains a wildcard.
    if (pattern === '**' || pattern.endsWith('/**') && !(0, _glob.hasMagic)(pattern.slice(0, -3), {
        magicalBraces: false
    })) {
        pattern += '/*';
    }
    return (0, _glob.globSync)(pattern, {
        follow: true,
        nodir: false
    }).map(function(dir) {
        return dir.replace(/\\/g, '/');
    }).filter(function(dir) {
        try {
            return (0, _fs.statSync)(dir).isDirectory();
        } catch (error) {
            if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
            throw error;
        }
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
