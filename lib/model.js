/**
 * Module exports class Model
 */
module.exports = ModelBaseClass;

/**
 * Module dependencies
 */

var util = require('util');
var traverse = require('traverse');
var jutil = require('./jutil');
var List = require('./list');
var Hookable = require('./hooks');
var validations = require('./validations.js');

var BASE_TYPES = ['String', 'Boolean', 'Number', 'Date', 'Text'];

/**
 * Model class - base class for all persist objects
 * provides **common API** to access any database connector.
 * This class describes only abstract behavior layer, refer to `lib/connectors/*.js`
 * to learn more about specific connector implementations
 *
 * `ModelBaseClass` mixes `Validatable` and `Hookable` classes methods
 *
 * @constructor
 * @param {Object} data - initial object data
 */
function ModelBaseClass(data, options) {
  options = options || {};
  if(!('applySetters' in options)) {
    // Default to true
    options.applySetters = true;
  }
  this._initProperties(data, options);
}

// FIXME: [rfeng] We need to make sure the input data should not be mutated. Disabled cloning for now to get tests passing
function clone(data) {
  /*
   if(!(data instanceof ModelBaseClass)) {
   if(data && (Array.isArray(data) || 'object' === typeof data)) {
   return traverse(data).clone();
   }
   }
   */
  return data;
}

/**
 * Initialize the model instance with a list of properties
 * @param {Object} data The data object
 * @param {Object} options An object to control the instantiation
 * @property {Boolean} applySetters Controls if the setters will be applied
 * @property {Boolean} strict Set the instance level strict mode
 * @private
 */
ModelBaseClass.prototype._initProperties = function (data, options) {
  var self = this;
  var ctor = this.constructor;

  var properties = ctor.definition.build();
  data = data || {};

  options = options || {};
  var applySetters = options.applySetters;
  var strict = options.strict;

  if(strict === undefined) {
    strict = ctor.definition.settings.strict;
  }
  Object.defineProperty(this, '__cachedRelations', {
    writable: true,
    enumerable: false,
    configurable: true,
    value: {}
  });

  Object.defineProperty(this, '__data', {
    writable: true,
    enumerable: false,
    configurable: true,
    value: {}
  });

  Object.defineProperty(this, '__dataWas', {
    writable: true,
    enumerable: false,
    configurable: true,
    value: {}
  });

  /**
   * Instance level data source
   */
  Object.defineProperty(this, '__dataSource', {
    writable: true,
    enumerable: false,
    configurable: true,
    value: options.dataSource
  });

  /**
   * Instance level strict mode
   */
  Object.defineProperty(this, '__strict', {
    writable: true,
    enumerable: false,
    configurable: true,
    value: strict
  });

  if (data.__cachedRelations) {
    this.__cachedRelations = data.__cachedRelations;
  }

  for (var i in data) {
    if (i in properties && typeof data[i] !== 'function') {
      this.__data[i] = this.__dataWas[i] = clone(data[i]);
    } else if (i in ctor.relations) {
      this.__data[ctor.relations[i].keyFrom] = this.__dataWas[i] = data[i][ctor.relations[i].keyTo];
      this.__cachedRelations[i] = data[i];
    } else {
      if (strict === false) {
        this.__data[i] = this.__dataWas[i] = clone(data[i]);
      } else if (strict === 'throw') {
        throw new Error('Unknown property: ' + i);
      }
    }
  }

  if (applySetters === true) {
    for (var propertyName in data) {
      if (typeof data[propertyName] !== 'function' && ((propertyName in properties) || (propertyName in ctor.relations))) {
        self[propertyName] = self.__data[propertyName] || data[propertyName];
      }
    }
  }

  // Set the unknown properties as properties to the object
  if (strict === false) {
    for (var propertyName in data) {
      if (typeof data[propertyName] !== 'function' && !(propertyName in properties)) {
        self[propertyName] = self.__data[propertyName] || data[propertyName];
      }
    }
  }

  ctor.forEachProperty(function (propertyName) {

    if (undefined === self.__data[propertyName]) {
      self.__data[propertyName] = self.__dataWas[propertyName] = getDefault(propertyName);
    } else {
      self.__dataWas[propertyName] = self.__data[propertyName];
    }

  });

  ctor.forEachProperty(function (propertyName) {

    var type = properties[propertyName].type;

    if (BASE_TYPES.indexOf(type.name) === -1) {
      if (typeof self.__data[propertyName] !== 'object' && self.__data[propertyName]) {
        try {
          self.__data[propertyName] = JSON.parse(self.__data[propertyName] + '');
        } catch (e) {
          self.__data[propertyName] = String(self.__data[propertyName]);
        }
      }
      if (type.name === 'Array' || Array.isArray(type)) {
        if (!(self.__data[propertyName] instanceof List)) {
          self.__data[propertyName] = new List(self.__data[propertyName], type, self);
        }
      }
    }

  });

  function getDefault(propertyName) {
    var def = properties[propertyName]['default'];
    if (def !== undefined) {
      if (typeof def === 'function') {
        return def();
      } else {
        return def;
      }
    } else {
      return undefined;
    }
  }

  this.trigger('initialize');
};

/**
 * @param {String} prop - property name
 * @param {Object} params - various property configuration
 */
ModelBaseClass.defineProperty = function (prop, params) {
  this.dataSource.defineProperty(this.modelName, prop, params);
};

ModelBaseClass.getPropertyType = function (propName) {
  var prop = this.definition.properties[propName];
  if (!prop) {
    // The property is not part of the definition
    return null;
  }
  if (!prop.type) {
    throw new Error('Type not defined for property ' + this.modelName + '.' + propName);
    // return null;
  }
  return prop.type.name;
};

ModelBaseClass.prototype.getPropertyType = function (propName) {
  return this.constructor.getPropertyType(propName);
};

/**
 * Return string representation of class
 *
 * @override default toString method
 */
ModelBaseClass.toString = function () {
  return '[Model ' + this.modelName + ']';
};

/**
 * Convert model instance to a plain JSON object
 *
 * @param {Boolean} onlySchema - restrict properties to dataSource only,
 * default to false. When onlySchema is true, only properties defined in
 * the schema are returned, otherwise all enumerable properties returned
 * @returns {Object} - canonical object representation (no getters and setters)
 */
ModelBaseClass.prototype.toObject = function (onlySchema) {
  if(onlySchema === undefined) {
    onlySchema = true;
  }
  var data = {};
  var self = this;

  var strict = this.__strict;
  var schemaLess = (strict === false) || !onlySchema;

  this.constructor.forEachProperty(function (propertyName) {
    if (self[propertyName] instanceof List) {
      data[propertyName] = self[propertyName].toObject(!schemaLess);
    } else if (self.__data.hasOwnProperty(propertyName)) {
      if (self[propertyName] !== undefined && self[propertyName] !== null && self[propertyName].toObject) {
        data[propertyName] = self[propertyName].toObject(!schemaLess);
      } else {
        data[propertyName] = self[propertyName];
      }
    } else {
      data[propertyName] = null;
    }
  });

  var val = null;
  if (schemaLess) {
    // Find its own properties which can be set via myModel.myProperty = 'myValue'.
    // If the property is not declared in the model definition, no setter will be
    // triggered to add it to __data
    for (var propertyName in self) {
      if(self.hasOwnProperty(propertyName) && (!data.hasOwnProperty(propertyName))) {
        val = self[propertyName];
        if (val !== undefined && val !== null && val.toObject) {
          data[propertyName] = val.toObject(!schemaLess);
        } else {
          data[propertyName] = val;
        }
      }
    }
    // Now continue to check __data
    for (propertyName in self.__data) {
      if (!data.hasOwnProperty(propertyName)) {
        val = self.hasOwnProperty(propertyName) ? self[propertyName] : self.__data[propertyName];
        if (val !== undefined && val !== null && val.toObject) {
          data[propertyName] = val.toObject(!schemaLess);
        } else {
          data[propertyName] = val;
        }
      }
    }
  }
  return data;
};

ModelBaseClass.prototype.toJSON = function () {
  return this.toObject(false);
};

ModelBaseClass.prototype.fromObject = function (obj) {
  for (var key in obj) {
    this[key] = obj[key];
  }
};

/**
 * Checks is property changed based on current property and initial value
 *
 * @param {String} propertyName - property name
 * @return Boolean
 */
ModelBaseClass.prototype.propertyChanged = function propertyChanged(propertyName) {
  return this.__data[propertyName] !== this.__dataWas[propertyName];
};

/**
 * Reset dirty attributes
 *
 * this method does not perform any database operation it just reset object to it's
 * initial state
 */
ModelBaseClass.prototype.reset = function () {
  var obj = this;
  for (var k in obj) {
    if (k !== 'id' && !obj.constructor.dataSource.definitions[obj.constructor.modelName].properties[k]) {
      delete obj[k];
    }
    if (obj.propertyChanged(k)) {
      obj[k] = obj[k + '$was'];
    }
  }
};

ModelBaseClass.prototype.inspect = function () {
  return util.inspect(this.__data, false, 4, true);
};

ModelBaseClass.mixin = function (anotherClass, options) {
  return jutil.mixin(this, anotherClass, options);
};

ModelBaseClass.prototype.getDataSource = function () {
  return this.__dataSource || this.constructor.dataSource;
};

ModelBaseClass.getDataSource = function () {
  return this.dataSource;
};

ModelBaseClass.prototype.setStrict = function (strict) {
  this.__strict = strict;
};

jutil.mixin(ModelBaseClass, Hookable);
jutil.mixin(ModelBaseClass, validations.Validatable);
