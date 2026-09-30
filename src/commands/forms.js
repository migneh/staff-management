'use strict';
module.exports = { components: {
  'form:retry': i => require('../services/componentDispatch').dispatch(i),
} };
