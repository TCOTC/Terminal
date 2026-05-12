const path = require("path");
const {EsbuildPlugin} = require("esbuild-loader");
const MiniCssExtractPlugin = require("mini-css-extract-plugin");
const CopyPlugin = require("copy-webpack-plugin");
const ZipPlugin = require("zip-webpack-plugin");

module.exports = (env, argv) => {
    const isPro = argv.mode === "production";
    const plugins = [
        new MiniCssExtractPlugin({
            filename: isPro ? "dist/index.css" : "index.css",
        })
    ];
    let entry = {
        "index": "./src/index.ts",
    };
    if (isPro) {
        entry = {
            "dist/index": "./src/index.ts",
        };
        plugins.push(new CopyPlugin({
            patterns: [
                {from: "preview.png", to: "./dist/"},
                {from: "icon.png", to: "./dist/"},
                {from: "README*.md", to: "./dist/"},
                {from: "plugin.json", to: "./dist/"},
                {from: "src/i18n/", to: "./dist/i18n/"},
                // 发版 zip 需包含 node-pty 原生模块，运行时从插件目录 require
                {
                    from: path.resolve(__dirname, "node_modules/node-pty"),
                    to: path.resolve(__dirname, "dist/node_modules/node-pty"),
                },
            ],
        }));
        plugins.push(new ZipPlugin({
            filename: "package.zip",
            algorithm: "gzip",
            include: [/dist/],
            pathMapper: (assetPath) => {
                return assetPath.replace("dist/", "");
            },
        }));
    } else {
        plugins.push(new CopyPlugin({
            patterns: [
                {from: "src/i18n/", to: "./i18n/"},
            ],
        }));
    }
    return {
        mode: argv.mode || "development",
        watch: !isPro,
        devtool: isPro ? false : "eval",
        output: {
            filename: "[name].js",
            path: path.resolve(__dirname),
            libraryTarget: "commonjs2",
            library: {
                type: "commonjs2",
            },
        },
        externals: {
            siyuan: "siyuan",
        },
        entry,
        optimization: {
            minimize: true,
            minimizer: [
                new EsbuildPlugin(),
            ],
        },
        resolve: {
            extensions: [".ts", ".scss", ".js", ".json"],
        },
        module: {
            rules: [
                {
                    test: /\.ts(x?)$/,
                    include: [path.resolve(__dirname, "src")],
                    use: [
                        {
                            loader: "esbuild-loader",
                            options: {
                                target: "es6",
                            }
                        },
                    ],
                },
                {
                    test: /\.css$/,
                    use: [
                        MiniCssExtractPlugin.loader,
                        "css-loader",
                    ],
                },
                {
                    test: /\.scss$/,
                    include: [path.resolve(__dirname, "src")],
                    use: [
                        MiniCssExtractPlugin.loader,
                        {
                            loader: "css-loader", // translates CSS into CommonJS
                        },
                        {
                            loader: "sass-loader", // compiles Sass to CSS
                        },
                    ],
                }
            ],
        },
        plugins,
    };
};
