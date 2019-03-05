#! /usr/bin/env node

(function () {

		var fs = require('fs');
		var express = require('express');
		var exphbs = require('express-handlebars');
		var hbsHelpers = require('../../hbs-helpers');
		var app = express();
		var routes = require('../../routes/index');
		var globby = require('globby');
		var mkdirp = require('mkdirp');
		var request = require('request');
		var shell = require('shelljs');
		var rmdir = require('rimraf');
		var getPort = require('get-port');
		var setPort;

		// set an env variable for use outside of build
		process.env.mzr_building = true;

		routes(app);

		require('dotenv').config({ silent: true });

		// handlebars config
		// namespace the partial folders for each site
		const partialsNamespacedDir = globby.sync(['./base/base-views/partials', './site-sections/**/views/partials']).map((partialPath) => {
			const site = partialPath.split('/')
				.filter(n =>
					n !== '' && // no blank
					n !== '.' && // no '.'
					n !== 'site-sections') // no site-sections
				.shift(); // grab the initial directory

			return {
				dir: partialPath,
				namespace: site
			};
		});

		// handlebars config
		const hbs = exphbs.create({
			extname: '.hbs',
			defaultLayout: 'default',
			helpers: hbsHelpers,
			layoutsDir: './base/base-views/layouts',
			partialsDir: partialsNamespacedDir
		});

		const ignoreArr = [];

		app.engine('.hbs', hbs.engine);
		app.set('view engine', '.hbs');
		app.use(express.static('public'));

		var server;

		ignoreArr.push('./base/base-views/layouts/*.hbs');

		hbs.partialsDir.forEach((partialObj) => {
			ignoreArr.push(`${partialObj.dir}/**/*.hbs`);
		});

		getPort().then(port => {
			setPort = port;
			server = app.listen(setPort);
		});

		/**
		 * compile hbs files from array using existing routes and data
		 * @param  {Array}   arr [array of hbs files to build]
		 * @param  {Function} cb  [callback function after files built]
		 */
		var compileFiles = (arr, cb) => {
			var processFiles = arr.map((file) => {

				return new Promise((resolve, reject) => {
					const urlArray = file.replace(/\.[^/.]+$/, '').split('/').filter(n => n !== '' && n !== '.' && n !== 'site-sections' && n !== 'views' && n !== 'root' && n !== 'index');
					const pathArray = Array.from(urlArray);
					var siteDirectory = (pathArray.length) ? pathArray.shift() : '';
					var view = (pathArray.length) ? pathArray.join('/') : 'index';

					if(view !== 'index'){
						siteDirectory = siteDirectory + `/${view}/`
						view = 'index';
					}
					const urlPath = `/${urlArray.join('/')}`;

					const options = {
						baseUrl: `http://localhost:${setPort}/`,
						method: 'GET',
						url: urlPath
					};

					// HTTP GET each page, build page/directory from response
					request(options, (error, response, body) => {
						// build directory structure or find existing
						mkdirp(`./build/` + siteDirectory, (err) => {
							if (err) reject(err);

							// build page within site directory, using view data.
							fs.writeFile(`./build/${siteDirectory}/${view}.html`, body, (err) => {
								if(err) reject(err);
								console.log(`Building ./build/${siteDirectory}/${view}.html`);
								resolve();
							});
						});
					}).on('error', (err) => reject(err) );
				});
			});

			Promise.all(processFiles).then(function() {
				console.log('All files processed.');
				cb();
			}).catch(function (err) {
				console.log(err);
				cb();
			});
		};

		/**
		 * compress the build directory and close the server
		 */
		var finalizeBuild = () => {
			var date = new Date();
			var day = date.getDate();
			var month = date.getMonth();
			var year = date.getFullYear();
			var timestamp = Math.floor(date.getTime() / 1000);
			var dateString = `${month}_${day}_${year}_${timestamp}`;

			var deploymentFile = JSON.parse(fs.readFileSync('./deployment.json', 'utf8'));
			var prefix = (JSON.stringify(deploymentFile.name)) ? (JSON.stringify(deploymentFile.name)) : 'project';

			shell.exec(`zip -r ${prefix}_build_${dateString}.zip build`, () => {
				server.close();
			});
		};

		var removeBuild = (callback) => {
			rmdir('./*.zip', () => {
				rmdir('./build', callback);
			});
		};

		var buildAssets = (callback) => {
			shell.exec('npm run build-assets-s3', callback);
		};

		/**
		 * run the gulp build command with production env to build and move js/css/images to the build directory
		 */
		removeBuild(function () {
			buildAssets();

			/**
			 * get all hbs files in the views directory and pass to compileFiles(), run finalizeBuild on completion.
			 * @param  {String} glob string
			 * @param  {Object} glob settings
			 * @param  {Function} glob callback
			 */

			globby('./site-sections/**/views/*.hbs', {
				ignore: ignoreArr
			}).then(data => {
				// compile files based on views directory, close server when complete.
				compileFiles(data, function () {
					setTimeout(() => {
						finalizeBuild();
					}, 10000)
				});
			});
		});
	})();
