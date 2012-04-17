var sms_utils = require('kujua-sms/utils'),
    utils = require('kujua-utils'),
    logger = utils.logger,
    templates = require('duality/templates'),
    _ = require('underscore')._,
    moment = require('moment');

var fieldsToHtml = function(keys, labels, data_record) {
    var fields = {
        headers: [],
        data: []
    };

    _.each(keys, function(key) {
        if(_.isArray(key)) {
            fields.headers.push({head: utils.titleize(key[0])});
            fields.data.push(_.extend(
                fieldsToHtml(key[1], labels, data_record[key[0]]),
                {isArray: true}
            ));
        } else {
            fields.headers.push({head: labels.shift()});
            fields.data.push({
                isArray: false,
                value: data_record[key]
            });
        }
    });

    return fields;
};

var makeDataRecordReadable = function(doc, locale) {
    var data_record = doc;
    var sms_message = data_record.sms_message;
    if(false && sms_message) {
        sms_message.short_message = sms_message.message.substr(0, 40) + '...';
        sms_message.message = sms_message.message.replace(
                                new RegExp('#', 'g'), "<br />");
    }

    if(data_record.form) {
        var keys = sms_utils.getFormKeys(data_record.form);
        var labels = sms_utils.getLabels(keys, data_record.form, 'en');
        data_record.fields = fieldsToHtml(keys, labels, data_record);
    }

    if(data_record.reported_date) {
        var m = moment(data_record.reported_date);
        data_record.reported_date = m.format('DD, MMM YYYY, hh:mm:ss');
    }

    return data_record;
};

var db = null,
    timeoutID = null,
    nextStartKey = null,
    firstRender = true,
    lastRecord = null,
    viewName = '',
    viewQuery = {},
    limit = 50,
    district = '',
    phones = {health_centers: [], district_hospitals: [], clinics: []},
    dh_id = null,
    form = null;
    
var renderRecords = function() {
    var q = viewQuery;

    if(nextStartKey) {
        q['startkey'] = nextStartKey;
    }

    var render = function(err, data) {
        if (err) { return alert(err); }

        if (data.rows && data.rows.length === 1) {
            lastRecord = data.rows[0];
            nextStartKey = null;
            $('.reached-last-record').show();
        } else if (data.total_rows < limit) {
            lastRecord = data.rows[data.rows.length - 1];
        } else if (data.rows && data.rows.length > 1) {
            nextStartKey = data.rows.pop().key;
        }
        var rows = _.map(data.rows, function(row, idx) {
            var r = makeDataRecordReadable(row.value);
            r._key = row.key;
            return r;
        });
        // render base template if this is the first render or we have no
        // rows.
        if(firstRender) {
            logger.debug('rendering first render');
            $('#loader').html(
                templates.render(
                    'data_records_table.html', {}, {data_records: rows}
                )
            );
            firstRender = false;
        } else {
            logger.debug('rendering update');
            $('#data-records .wrap').append(
                templates.render(
                    'data_records_rows.html', {}, {data_records: rows}
                )
            );
        }
        delete timeoutID;
        $('.ajax-loader').hide();
    };
    
    if(!viewName) {
        render(null, []);
    } else if(!lastRecord) {
        db.getView(
            'kujua-export',
            viewName,
            q,
            render);
    }
};

var loadPhones = function() {
    var q = {group:true};
    
    if (dh_id) {
        q['startkey'] = [dh_id];
        q['endkey'] = [dh_id, {}];
    }
    db.getView(
        'kujua-export',
        'phones_by_district_and_health_center',
        q,
        function(err, data) {
            if (err) {
                return alert(err);
            }
            for (var i in data.rows) {
                var row = data.rows[i];
                phones.health_centers.push(
                    [row.key[4], row.key[3], row.key[2]].join(', '));
            }
        }
    );
    db.getView(
        'kujua-export',
        'phones_by_district_and_clinic',
        q,
        function(err, data) {
            if (err) {
                return alert(err);
            }
            for (var i in data.rows) {
                var row = data.rows[i];
                phones.clinics.push(
                    [row.key[4], row.key[3], row.key[2]].join(', '));
            }
        }
    );
    db.getView(
        'kujua-export',
        'phones_by_district',
        q,
        function(err, data) {
            if (err) {
                return alert(err);
            }
            for (var i in data.rows) {
                var row = data.rows[i];
                phones.district_hospitals.push(
                    [row.key[4], row.key[3], row.key[2]].join(', '));
            }
        }
    );
};

var cancel = function() {
    if(typeof timeoutID === "number") {
        window.clearTimeout(timeoutID);
        delete timeoutID;
    }
};

var setup = function() {
    cancel();
    if(!lastRecord) {
        $('.ajax-loader').show();
        timeoutID = window.setTimeout(
            function(msg) {renderRecords();}, 700);
    }
};

exports.addListeners = function() {
    logger.debug('addListeners');

    $(window).scroll(function () {
        if ($(window).scrollTop() >= $(document).height()
                - $(window).height() - 10) {
            log('scroll');
            setup();
        }
    });
    // bind to: field error marks so they can be updated
    $(document).on('click', '.tasks-referral .error-missing-phone',
        function(ev) {
            $(this).hide();
            var form = $(this).siblings('form');
            form.css({display: 'inline'});
            // configure bootstrap typeahead effect
            $('[name=phone]', form).typeahead({
                source: phones.health_centers,
                items: 20,
                highlighter: function (item) {
                    //override default highlighter to escape '+'s
                    var q = this.query.replace(/[\\+]+/, '\\\\+');
                    return item.replace(new RegExp('(' + q + ')', 'ig'),
                        function ($1, match) {
                            return '<strong>' + match + '</strong>';
                        }
                    );
                }
            }).focus();
    });
    // remove error highlighting on subsequent tries
    $(document).on(
        'focus',
        '.tasks-referral .control-group [type=text]',
        function(ev) {
            $(this).closest('.control-group').removeClass('error');
    });
    // handle updating of 'to' field in referral task
    $(document).on('click', '.tasks-referral [type=submit]', function(ev) {
        ev.stopPropagation();
        ev.preventDefault();
        var btn = $(this),
            form = btn.closest('form'),
            rev = btn.siblings('input[name=_rev]').val(),
            id = btn.siblings('input[name=_id]').val(),
            tasks_idx = parseInt(btn.closest('table').attr('data-tasks-idx'), 10),
            idx = parseInt(btn.siblings('input[name=idx]').val(), 10),
            input = btn.siblings('input[type=text]'),
            match = input.val().match(/.*(\+\d{11}).*/),
            phone = match ? match[1] : '';
        if(!phone) {
            btn.closest('.control-group').addClass('error');
            return;
        }
        db.getDoc(id, function(err, data) {
            if (err) { return alert(err); }
            data.tasks[tasks_idx].messages[idx].to = phone;
            data.tasks[tasks_idx].state = 'pending';
            data._rev = rev; // set the rev from the form
            
            for (var i in data.errors) {
                // remove related errors
                var e = data.errors[i];
                if (e.error === 'Could not find referral recipient.') {
                    // legacy error messages
                    data.errors.splice(i, 1);
                } else if (e.code === 'recipient_not_found') {
                    data.errors.splice(i, 1);
                }
            }

            db.saveDoc(data, function(err, data) {
                if (err) { return alert(err); }
                if(!data.ok) {
                    return alert('saveDoc failed.');
                }
                //once doc is saved changes listener will update the row
            });
        });
    });
    var showEdit = function(ev) {
        logger.debug('fire showEdit');
        $(this).find('.row-controls').show();
        //$(this).toggleClass('active');
    };

    var hideEdit = function(ev) {
        logger.debug('fire hideEdit');
        var div = $(this).find('.row-controls');
        div.hide();
        //$(this).toggleClass('active');
    };

    // bind/unbind events for edit mode
    $('.edit-mode').toggle(function(ev) {
        $(document).on('mouseenter', '#data-records tr.main', showEdit);
        $(document).on('mouseleave', '#data-records tr.main', hideEdit);
        $(this).addClass('active');
    }, function(ev) {
        $(document).off('mouseenter', '#data-records tr.main');
        $(document).off('mouseleave', '#data-records tr.main');
        $(this).removeClass('active');
    });

    $(document).on('click', '#data-records tr.main', function(ev) {
        ev.preventDefault();
        var table = $(this).parents('table').next();
        table.toggle();
    });

    $(document).on('click', '[data-dismiss=extended]', function(ev) {
        $(this).closest('.extended').hide();
    });

    // bind to edit row button
    $(document).on('click', '.row-controls .edit', function(ev) {
        ev.preventDefault();
        $(this).siblings('form').toggle();
    });

    // bind to delete buttons
    $(document).on('click', 'form[data-ajax=removeDoc]', function(ev) {
        ev.preventDefault();
        ev.stopPropagation();
        var form = $(this),
            _id = form.find('[name=_id]').val(),
            _rev = form.find('[name=_rev]').val(),
            tds = $('[rel='+_id+'] .main td');

        // highlight row to warn user
        tds.addClass('warning');

        if(confirm('Remove permanently?')) {
            db.removeDoc({_id: _id, _rev: _rev}, function(err, resp) {
                if (err) {
                    return alert(err);
                }
                // doing actual delete in changes feed sub instead of here
                // to avoid race condition
            });
        } else {
            tds.removeClass('warning');
        }
    });
};

exports.removeListeners = function() {
    $(window).off('scroll');
    $(document).off('click', '.tasks-referral .to .error');
    $(document).off('mouseenter', '#data-records tr.main');
    $(document).off('mouseleave', '#data-records tr.main');
};

// return boolean true if the record matches the logged in user
var isInDistrict = function(record) {
    if(isAdmin) { return true; }

    if (record.related_entities.clinic &&
        record.related_entities.clinic.parent &&
        record.related_entities.clinic.parent.parent &&
        record.related_entities.clinic.parent.parent._id) {

        var district = record.related_entities.clinic.parent.parent._id;
        return district === district;
    } else {
        return false;
    }
};

var subChanges = function() {
    db.changes({include_docs: true}, function(err,data) {
        if (err) { console.log(err); return; }
        if (!data || !data.results) { return; }

        _.each(data.results, function(result) {
            var type = result.doc.type;

            // only handle changes for data records
            if (result.doc.type &&
                !result.doc.type.match(/^data_record/)) { return; }

            // not design docs
            if (result.id.match(/_design\//)) { return; }

            var div = $('[rel='+result.id+']');

            // remove deleted records
            if (result.deleted && div.length > 0) {
                div.fadeOut(500, function() { $(this).remove(); });
                return;
            }

            // if not deleted, then only update for this district
            if (!isInDistrict(result.doc)) { return; }

            // render new/updated records
            var doc = makeDataRecordReadable(result.doc),
                html = templates.render(
                    'data_records_rows.html', {}, {data_records: [doc]});

            if(div.length > 0) {
                div.replaceWith(html);
            } else {
                $(html).insertBefore('#data-records .data-record:first')
                    .hide().fadeIn(500);
            }
        });
    });
};

exports.init = function(req, _district, _isAdmin, _dh_id, _form, callback) {
    district = _district;
    isAdmin = _isAdmin;
    form = _form;
    dh_id = district ? district : _dh_id;
    
    var q = _.extend(req.query, {
        limit: limit || 50,
        descending: true,
        startkey: [{}],
        endkey: []
    });

    if(form) {
        q.startkey.unshift(form);
        q.endkey.unshift(form);
    }
    if (dh_id) {
        q.startkey.unshift(dh_id);
        q.endkey.unshift(dh_id);
    }

    db = require('db').current(req);

    // we need these reset for the initial show
    nextStartKey = null;
    lastRecord = null;
    firstRender = true;

    // user must either be admin or have associated district to view
    // records also show records by reported_date if no district filter is
    // applied.
    if (isAdmin && !dh_id && !form) {
        viewName = 'data_records_by_reported_date';
        viewQuery = q;
    } else if (isAdmin || district) {
        if(form && dh_id) {
            viewName = 'data_records_by_district_form_and_reported_date';
        } else if(form && !dh_id) {
            viewName = 'data_records_by_form_and_reported_date';
        } else if(!form && dh_id) {
            viewName = 'data_records_by_district_and_reported_date';
        }
        
        viewQuery = q;
    }

    renderRecords();
    loadPhones();
    subChanges();
}