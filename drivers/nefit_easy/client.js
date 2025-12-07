const { NefitEasyCommands } = require('nefit-easy-commands');

module.exports = class NefitEasyClient extends NefitEasyCommands {
  holidayMode() {
    return this.get('/heatingCircuits/hc1/holidayMode/status');
  }

  setHolidayMode(value) {
    return this.put('/heatingCircuits/hc1/holidayMode/status', { value : value ? 'on' : 'off' });
  }

  // get shower timer on/off
  showerTimer() {
    return this.get('/dhwCircuits/dhwA/extraDhw/status');
  }

  // set shower timer on/off
  setShowerTimer(value) {
    return this.put('/dhwCircuits/dhwA/extraDhw/status', { value : value ? 'on' : 'off' });
  }

  // set time to shower timer
  setShowerTime(value) {
    return this.put('/dhwCircuits/dhwA/extraDhw/duration', { value });
  }
};
