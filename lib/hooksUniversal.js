// --------------------
// Sequelize hierarchy
// Hooks on all models
// --------------------

// modules
var _ = require('lodash');

// imports
var patchesFn = require('./patches');

// exports

module.exports = function(Sequelize) {
	var patches = patchesFn(Sequelize);

	return {
		afterDefine: function(model) {
			// get hierarchy option
			var hierarchy = model.options.hierarchy;

			// check for hierarchy set on a field
			_.forIn(model.attributes, function(field, fieldName) {
				if (!field.hierarchy) return;

				if (hierarchy) throw new Sequelize.HierarchyError("You cannot define hierarchy on two attributes, or an attribute and the model options, in '" + model.name + "'");

				hierarchy = field.hierarchy;
				if (hierarchy === true) hierarchy = {};

				// deduce foreignKey and as for the hierarchy from field name
				hierarchy.foreignKey = fieldName;
				var primaryKey = hierarchy.primaryKey || model.primaryKeyAttribute;
				if (!hierarchy.as) {
					if (_.endsWith(fieldName, Sequelize.Utils.uppercaseFirst(primaryKey))) {
						hierarchy.as = fieldName.slice(0, -primaryKey.length);
					} else if (_.endsWith(fieldName, '_' + primaryKey)) {
						hierarchy.as = fieldName.slice(0, -primaryKey.length - 1);
					} else {
						hierarchy.as = fieldName;
					}
				}

				model.options.hierarchy = hierarchy;
				field.hierarchy = true;
			});

			// if hierarchy set, init hierarchy
			if (hierarchy) model.isHierarchy(hierarchy);
		},

		beforeFindAfterExpandIncludeAll: function(options) {
			// check options do not include illegal hierarchies
			var hierarchyExists = false;
			if (options.hierarchy) {
				if (!this.hierarchy) throw new Sequelize.HierarchyError("You cannot get hierarchy of '" + this.name + "' - it is not hierarchical");
				hierarchyExists = true;
			}

			// record whether `hierarchy` is set anywhere in includes, so expansion of hierarchies can be skipped if their are none
			options.hierarchyExists = hierarchyExists || checkHierarchy(options, this);
		},
		afterFind: function(result, options) {
			// if no results, return
			if (!result) return;

			// if no hierarchies to expand anywhere in tree of includes, return
			if (!options.hierarchyExists) return;

			var parent;

			// where called from getDescendents, find id of parent
			if (options.hierarchy && options.includeMap) {
				var include = options.includeMap[this.hierarchy.through.name];

				if (include && include.where && include.where[this.hierarchy.throughForeignKey]) {
					parent = {};
					parent[this.hierarchy.primaryKey] = include.where[this.hierarchy.throughForeignKey];
				}
			}

			// convert hierarchies into trees
			convertHierarchies(result, options, this, parent);

			// where called from getDescendents, retrieve result from parent.children
			if (parent) {
				result.length = 0;
				result.push.apply(result, parent[this.hierarchy.childrenAs]);
			}
		}
	};

	function checkHierarchy(options, model) {
		// check options do not include illegal hierarchies - throw error if so
		if (!options.include) return;

		var hierarchyExists = false;
		options.include.forEach(function(include) {
			var includeModel = include.model;

			// if hierarchy set, check is legal
			if (include.hierarchy) {
				if (!includeModel.hierarchy) throw new Sequelize.HierarchyError("You cannot get hierarchy of '" + includeModel.name + "' - it is not hierarchical");
				// use model names rather than model references to compare, as Model.scope() results in a new model object.
				if (includeModel.name.singular !== model.name.singular) throw new Sequelize.HierarchyError("You cannot get a hierarchy of '" + includeModel.name + "' without including it from a parent");
				if (include.as !== model.hierarchy.descendentsAs) throw new Sequelize.HierarchyError("You cannot set hierarchy on '" + model.name + "' without using the '" + model.hierarchy.descendentsAs + "' accessor");
				hierarchyExists = true;
			}

			// check includes
			hierarchyExists = hierarchyExists || checkHierarchy(include, includeModel);
		});

		return hierarchyExists;
	}

	function convertHierarchies(results, options, model, parent) {
		if (!results) return;

		// convert hierarchies into trees
		if (options.include) {
			options.include.forEach(function(include) {
				var includeModel = include.model,
					accessor = include.as;

				if (!Array.isArray(results)) results = [results];

				results.forEach(function(result) {
					convertHierarchies(result[accessor], include, includeModel, result);
				});
			});
		}

		if (options.hierarchy) convertHierarchy(results, model, parent);
	}

	function convertHierarchy(results, model, parent) {
		var hierarchy = model.hierarchy,
			primaryKey = hierarchy.primaryKey,
			foreignKey = hierarchy.foreignKey,
			childrenAccessor = hierarchy.childrenAs,
			descendentsAccessor = hierarchy.descendentsAs,
			throughAccessor = hierarchy.through.name;

		// get parent id and create output array
		var parentId, output;
		if (parent) {
			parentId = parent[primaryKey];

			// remove parent.descendents and create empty parent.children array
			output = [];
			parent[childrenAccessor] = output;
			delete parent[descendentsAccessor];

			if (patches.isModelInstance(parent)) {
				parent.dataValues[childrenAccessor] = output;
				delete parent.dataValues[descendentsAccessor];
			}
		} else {
			parentId = null;

			// duplicate results array and empty output array
			output = results;
			results = results.slice();
			output.length = 0;
		}

		// run through all results, turning into tree

		// create references object keyed by id
		var references = {};
		results.forEach(function(item) {
			references[item[primaryKey]] = item;
		});

		// run through results, transferring to output array or nesting within parent
		results.forEach(function(item) {
			// remove reference to through table
			delete item[throughAccessor];
			if (patches.isModelInstance(item)) delete item.dataValues[throughAccessor];

			// if top-level item, add to output array
			var thisParentId = item[foreignKey];
			if (thisParentId === parentId) {
				output.push(item);
				return;
			}

			// not top-level item - nest inside parent
			var parent = references[thisParentId];
			if (!parent) throw new Sequelize.HierarchyError('Parent ID ' + thisParentId + ' not found in result set');

			var parentChildren = parent[childrenAccessor];
			if (!parentChildren) {
				parentChildren = parent[childrenAccessor] = [];
				if (patches.isModelInstance(parent)) parent.dataValues[childrenAccessor] = parentChildren;
			}

			parentChildren.push(item);
		});
	}
};
